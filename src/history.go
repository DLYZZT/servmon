package main

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Each record is 48 bytes: unix seconds + ten float32 slots. Atomic snapshots
// of bounded rings avoid torn header/record writes and need no CGO/database.
type historyTier struct {
	Step     int64
	Capacity int
	Rows     []Sample
	Sum      Sample
	Count    int
	Bucket   int64
}
type HistoryStore struct {
	mu     sync.RWMutex
	dir    string
	tiers  map[string][]*historyTier
	recent map[string][]Sample
}

func newTiers() []*historyTier {
	return []*historyTier{{Step: 60, Capacity: 1440}, {Step: 600, Capacity: 4320}}
}
func NewHistory(dir string) *HistoryStore {
	h := &HistoryStore{dir: dir, tiers: map[string][]*historyTier{}, recent: map[string][]Sample{}}
	h.ensure("")
	return h
}
func (h *HistoryStore) path(key string, step int64) string {
	return filepath.Join(h.dir, fmt.Sprintf("history-%x-%d.bin", sha256.Sum256([]byte(key)), step))
}
func (h *HistoryStore) ensure(key string) []*historyTier {
	if t, ok := h.tiers[key]; ok {
		return t
	}
	ts := newTiers()
	h.tiers[key] = ts
	if h.dir != "" {
		for _, t := range ts {
			b, e := os.ReadFile(h.path(key, t.Step))
			if e != nil {
				continue
			}
			if len(b) < 8 || string(b[:8]) != "SVMH0001" || (len(b)-8)%48 != 0 {
				log.Printf("忽略损坏历史文件 %s", h.path(key, t.Step))
				continue
			}
			for p := 8; p < len(b); p += 48 {
				v := decodeSample(b[p : p+48])
				if len(t.Rows) > 0 && v.T <= t.Rows[len(t.Rows)-1].T {
					continue
				}
				t.Rows = append(t.Rows, v)
			}
			if len(t.Rows) > t.Capacity {
				t.Rows = t.Rows[len(t.Rows)-t.Capacity:]
			}
		}
	}
	return ts
}
func encodeSample(s Sample) []byte {
	b := make([]byte, 48)
	binary.LittleEndian.PutUint64(b, uint64(s.T))
	for i, v := range []float64{s.CPU, s.Mem, s.RxBps, s.TxBps, s.Load1, s.Disk, s.Temp, s.ReadBps, s.WriteBps, 0} {
		binary.LittleEndian.PutUint32(b[8+i*4:], math.Float32bits(float32(v)))
	}
	return b
}
func decodeSample(b []byte) Sample {
	v := make([]float64, 10)
	for i := range v {
		v[i] = float64(math.Float32frombits(binary.LittleEndian.Uint32(b[8+i*4:])))
	}
	return Sample{T: int64(binary.LittleEndian.Uint64(b)), CPU: v[0], Mem: v[1], RxBps: v[2], TxBps: v[3], Load1: v[4], Disk: v[5], Temp: v[6], ReadBps: v[7], WriteBps: v[8]}
}
func atomicWrite(path string, b []byte) error {
	f, e := os.CreateTemp(filepath.Dir(path), ".servmon-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e == nil {
		e = os.Rename(f.Name(), path)
	}
	return e
}
func (h *HistoryStore) save(key string, t *historyTier) {
	if h.dir == "" {
		return
	}
	b := []byte("SVMH0001")
	for _, s := range t.Rows {
		b = append(b, encodeSample(s)...)
	}
	if e := atomicWrite(h.path(key, t.Step), b); e != nil {
		log.Printf("历史写入失败，继续内存模式: %v", e)
	}
}
func mean(t *historyTier) Sample {
	s := t.Sum
	n := float64(t.Count)
	if n > 0 {
		s.CPU /= n
		s.Mem /= n
		s.RxBps /= n
		s.TxBps /= n
		s.Load1 /= n
		s.Temp /= n
		s.ReadBps /= n
		s.WriteBps /= n
	}
	s.T = t.Bucket
	return s
}
func addSum(t *historyTier, s Sample) {
	t.Count++
	t.Sum.CPU += s.CPU
	t.Sum.Mem += s.Mem
	t.Sum.RxBps += s.RxBps
	t.Sum.TxBps += s.TxBps
	t.Sum.Load1 += s.Load1
	t.Sum.Temp += s.Temp
	t.Sum.ReadBps += s.ReadBps
	t.Sum.WriteBps += s.WriteBps
	if s.Disk > t.Sum.Disk {
		t.Sum.Disk = s.Disk
	}
}
func (h *HistoryStore) Add(key string, s Sample) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.recent[key] = append(h.recent[key], s)
	for len(h.recent[key]) > 0 && h.recent[key][0].T < s.T-180 {
		h.recent[key] = h.recent[key][1:]
	}
	for _, t := range h.ensure(key) {
		bucket := s.T / t.Step * t.Step
		if t.Count > 0 && bucket != t.Bucket {
			h.commit(key, t)
		}
		if t.Count == 0 {
			t.Bucket = bucket
		}
		addSum(t, s)
	}
}
func (h *HistoryStore) commit(key string, t *historyTier) {
	s := mean(t)
	if n := len(t.Rows); n > 0 && t.Rows[n-1].T == s.T {
		t.Rows[n-1] = s
	} else {
		t.Rows = append(t.Rows, s)
	}
	if len(t.Rows) > t.Capacity {
		t.Rows = t.Rows[len(t.Rows)-t.Capacity:]
	}
	h.save(key, t)
	t.Count = 0
	t.Sum = Sample{}
}
func (h *HistoryStore) Flush() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for key, ts := range h.tiers {
		for _, t := range ts {
			if t.Count > 0 {
				h.commit(key, t)
			}
		}
	}
}

var historyRanges = map[string]time.Duration{"3m": 3 * time.Minute, "1h": time.Hour, "24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour}

func (h *HistoryStore) Get(key, r string, now time.Time) []Sample {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := []Sample{}
	var rows []Sample
	if r == "3m" {
		rows = h.recent[key]
	} else {
		ts := h.ensure(key)
		i := 0
		if r == "7d" || r == "30d" {
			i = 1
		}
		rows = append([]Sample{}, ts[i].Rows...)
		if ts[i].Count > 0 {
			s := mean(ts[i])
			if len(rows) > 0 && rows[len(rows)-1].T == s.T {
				rows[len(rows)-1] = s
			} else {
				rows = append(rows, s)
			}
		}
	}
	cut := now.Add(-historyRanges[r]).Unix()
	for _, s := range rows {
		if s.T >= cut && s.T <= now.Unix() {
			out = append(out, s)
		}
	}
	return out
}
