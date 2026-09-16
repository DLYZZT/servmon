package main

import (
	"context"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/net"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type NetInfo struct {
	Name    string  `json:"name"`
	Rx      float64 `json:"rx"`
	Tx      float64 `json:"tx"`
	RxTotal uint64  `json:"rxTotal"`
	TxTotal uint64  `json:"txTotal"`
}

func counterRate(n, prev uint64, dt float64) float64 {
	if dt <= 0 || n < prev {
		return 0
	}
	return float64(n-prev) / dt
}
func (s *Sampler) collectIO(o *Overview, now time.Time) {
	dt := s.interval.Seconds()
	if !s.ioTime.IsZero() {
		dt = now.Sub(s.ioTime).Seconds()
	}
	s.ioTime = now
	ns, _ := net.IOCounters(true)
	o.Interfaces = []NetInfo{}
	for _, n := range ns {
		if n.Name == "lo" || n.Name == "lo0" {
			continue
		}
		p, ok := s.lastIfaces[n.Name]
		v := NetInfo{Name: n.Name, RxTotal: n.BytesRecv, TxTotal: n.BytesSent}
		if ok {
			v.Rx = counterRate(n.BytesRecv, p.BytesRecv, dt)
			v.Tx = counterRate(n.BytesSent, p.BytesSent, dt)
		}
		o.Interfaces = append(o.Interfaces, v)
		s.lastIfaces[n.Name] = n
	}
	sort.Slice(o.Interfaces, func(i, j int) bool { return o.Interfaces[i].Name < o.Interfaces[j].Name })
	ios, _ := disk.IOCounters()
	for i, d := range o.Disks {
		device := filepath.Base(d.Device)
		v, ok := ios[device]
		if !ok { // Match a partition to its parent block device, but never sum parent and child.
			for name, c := range ios {
				if strings.HasPrefix(device, name) && len(device) > len(name) {
					suffix := strings.TrimPrefix(device, name)
					if suffix[0] >= '0' && suffix[0] <= '9' || suffix[0] == 'p' {
						v = c
						device = name
						ok = true
						break
					}
				}
			}
		}
		if p, exists := s.lastIO[device]; ok && exists {
			o.Disks[i].ReadBps = counterRate(v.ReadBytes, p.ReadBytes, dt)
			o.Disks[i].WriteBps = counterRate(v.WriteBytes, p.WriteBytes, dt)
		}
	}
	seen := map[string]bool{}
	for _, d := range o.Disks {
		if !seen[d.Device] {
			o.Current.ReadBps += d.ReadBps
			o.Current.WriteBps += d.WriteBps
			seen[d.Device] = true
		}
	}
	s.lastIO = ios
}
func (s *Sampler) RunProcesses(ctx context.Context, interval time.Duration, notify func()) {
	s.collectProcesses()
	if notify != nil {
		notify()
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.collectProcesses()
			if notify != nil {
				notify()
			}
		}
	}
}
