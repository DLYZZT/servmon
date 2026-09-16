package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type AlertEvent struct {
	Host      string    `json:"host"`
	Rule      string    `json:"rule"`
	State     string    `json:"state"`
	Value     float64   `json:"value"`
	Threshold float64   `json:"threshold"`
	Since     time.Time `json:"since"`
	Message   string    `json:"message"`
	At        time.Time `json:"at"`
}
type alertState struct {
	Since  time.Time
	Last   time.Time
	Firing bool
	Event  AlertEvent
}
type AlertSnapshot struct {
	Active  []AlertEvent `json:"active"`
	History []AlertEvent `json:"history"`
}
type Alerter struct {
	mu      sync.Mutex
	cfg     AlertConfig
	states  map[string]*alertState
	history []AlertEvent
	notify  func(AlertEvent)
}

func NewAlerter(c AlertConfig, notify func(AlertEvent)) *Alerter {
	return &Alerter{cfg: c, states: map[string]*alertState{}, notify: notify}
}
func (a *Alerter) evaluate(host, rule string, value, threshold float64, bad bool, now time.Time) {
	st := a.states[rule]
	if st == nil {
		st = &alertState{}
		a.states[rule] = st
	}
	if !bad {
		if st.Firing {
			e := st.Event
			e.State = "resolved"
			e.Value = value
			e.At = now
			e.Message = fmt.Sprintf("%s recovered after %s", rule, now.Sub(st.Since).Round(time.Second))
			a.emit(e)
		}
		*st = alertState{}
		return
	}
	if st.Since.IsZero() {
		st.Since = now
	}
	if now.Sub(st.Since) < a.cfg.Sustain {
		return
	}
	if st.Firing && now.Sub(st.Last) < a.cfg.Cooldown {
		return
	}
	st.Firing = true
	st.Last = now
	st.Event = AlertEvent{Host: host, Rule: rule, State: "firing", Value: value, Threshold: threshold, Since: st.Since, At: now, Message: fmt.Sprintf("%s: %.2f >= %.2f", rule, value, threshold)}
	a.emit(st.Event)
}
func (a *Alerter) emit(e AlertEvent) {
	a.history = append([]AlertEvent{e}, a.history...)
	if len(a.history) > 50 {
		a.history = a.history[:50]
	}
	if a.notify != nil {
		a.notify(e)
	}
}
func (a *Alerter) Evaluate(o Overview, services []ServiceInfo, now time.Time) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, r := range []struct {
		name             string
		value, threshold float64
	}{{"cpu", o.Current.CPU, a.cfg.CPU}, {"mem", o.Current.Mem, a.cfg.Mem}, {"load1", o.Current.Load1, a.cfg.Load1}} {
		if r.threshold > 0 {
			a.evaluate(o.Host, r.name, r.value, r.threshold, r.value >= r.threshold, now)
		}
	}
	if a.cfg.Disk > 0 {
		for _, d := range o.Disks {
			a.evaluate(o.Host, "disk:"+d.Mount, d.Percent, a.cfg.Disk, d.Percent >= a.cfg.Disk, now)
		}
	}
	if a.cfg.ServiceFailed {
		for _, s := range services {
			if s.Active == "unknown" {
				continue
			}
			v := 0.0
			if s.Active == "failed" {
				v = 1
			}
			a.evaluate(o.Host, "service:"+s.Name, v, 1, v == 1, now)
		}
	}
}
func (a *Alerter) Snapshot() AlertSnapshot {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := AlertSnapshot{Active: []AlertEvent{}, History: append([]AlertEvent{}, a.history...)}
	for _, s := range a.states {
		if s.Firing {
			out.Active = append(out.Active, s.Event)
		}
	}
	sort.Slice(out.Active, func(i, j int) bool { return out.Active[i].Rule < out.Active[j].Rule })
	return out
}

type delivery struct {
	Event    AlertEvent `json:"event"`
	Target   string     `json:"target"`
	Telegram bool       `json:"telegram"`
	Attempts int        `json:"attempts"`
	Next     time.Time  `json:"next"`
}
type Notifier struct {
	persistMu sync.Mutex
	revision  uint64
	saved     uint64
	mu        sync.Mutex
	queue     []delivery
	cfg       NotifyConfig
	path      string
	wake      chan struct{}
	client    *http.Client
}

func NewNotifier(c NotifyConfig, dir string) *Notifier {
	n := &Notifier{cfg: c, wake: make(chan struct{}, 1), client: &http.Client{Timeout: 10 * time.Second}}
	if dir != "" {
		n.path = filepath.Join(dir, "notifications.json")
		if b, e := os.ReadFile(n.path); e == nil {
			if e = json.Unmarshal(b, &n.queue); e != nil {
				log.Printf("通知队列损坏: %v", e)
			}
		}
	}
	return n
}
func (n *Notifier) persist() {
	if n.path == "" {
		return
	}
	n.persistMu.Lock()
	defer n.persistMu.Unlock()
	n.mu.Lock()
	if n.saved == n.revision {
		n.mu.Unlock()
		return
	}
	revision := n.revision
	snapshot := append([]delivery{}, n.queue...)
	n.mu.Unlock()
	b, _ := json.Marshal(snapshot)
	if e := atomicWrite(n.path, b); e != nil {
		log.Printf("通知队列暂存失败，保留内存队列: %v", e)
	} else {
		n.mu.Lock()
		n.saved = revision
		n.mu.Unlock()
	}
}

// Enqueue only takes the queue lock. Disk/network work is owned by the worker.
func (n *Notifier) Enqueue(e AlertEvent) {
	n.mu.Lock()
	n.revision++
	for _, u := range n.cfg.Webhook {
		n.queue = append(n.queue, delivery{Event: e, Target: u})
	}
	if n.cfg.Telegram.Token != "" && n.cfg.Telegram.ChatID != "" {
		n.queue = append(n.queue, delivery{Event: e, Telegram: true})
	}
	n.mu.Unlock()
	select {
	case n.wake <- struct{}{}:
	default:
	}
}
func (n *Notifier) send(ctx context.Context, d delivery) error {
	url := d.Target
	var body any = d.Event
	if d.Telegram {
		url = "https://api.telegram.org/bot" + n.cfg.Telegram.Token + "/sendMessage"
		escape := strings.NewReplacer("\\", "\\\\", "_", "\\_", "*", "\\*", "[", "\\[", "`", "\\`")
		body = map[string]any{"chat_id": n.cfg.Telegram.ChatID, "parse_mode": "Markdown", "text": fmt.Sprintf("*%s*\n%s · %s\n`%.2f / %.2f`\n%s", escape.Replace(d.Event.Host), escape.Replace(d.Event.Rule), d.Event.State, d.Event.Value, d.Event.Threshold, escape.Replace(d.Event.Message))}
	}
	b, _ := json.Marshal(body)
	r, e := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(b))
	if e != nil {
		return fmt.Errorf("invalid notification URL")
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Servmon-Event", d.Event.State)
	resp, e := n.client.Do(r)
	if e != nil {
		return fmt.Errorf("notification transport failed")
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("notification HTTP %d", resp.StatusCode)
	}
	return nil
}
func (n *Notifier) Run(ctx context.Context) {
	for {
		n.persist()
		n.mu.Lock()
		index := -1
		blocked := map[string]bool{}
		for i, d := range n.queue {
			key := d.Target
			if d.Telegram {
				key = "telegram"
			}
			if blocked[key] {
				continue
			}
			blocked[key] = true
			if !time.Now().Before(d.Next) {
				index = i
				break
			}
		}
		var d delivery
		if index >= 0 {
			d = n.queue[index]
		}
		n.mu.Unlock()
		if index < 0 {
			timer := time.NewTimer(time.Second)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-n.wake:
				timer.Stop()
			case <-timer.C:
			}
			continue
		}
		err := n.send(ctx, d)
		if ctx.Err() != nil {
			return
		}
		n.mu.Lock()
		if err == nil {
			n.queue = append(n.queue[:index], n.queue[index+1:]...)
			n.revision++
		} else {
			n.queue[index].Attempts++
			n.revision++
			attempt := n.queue[index].Attempts
			delay := 30 * time.Second
			if attempt <= 3 {
				delay = time.Duration(1<<(attempt-1)) * time.Second
			}
			n.queue[index].Next = time.Now().Add(delay)
			log.Printf("通知暂未送达，将继续重试: %v", err)
		}
		n.mu.Unlock()
	}
}
func waitContext(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
func (n *Notifier) Flush() { n.persist() }
