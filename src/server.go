package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/shirou/gopsutil/v3/process"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type streamEvent struct {
	Name string
	Data []byte
}
type Hub struct {
	mu      sync.Mutex
	clients map[chan streamEvent]bool
}

func NewHub() *Hub { return &Hub{clients: map[chan streamEvent]bool{}} }
func (h *Hub) Publish(name string, data any) {
	b, e := json.Marshal(data)
	if e != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		select {
		case c <- streamEvent{name, b}:
		default: // Disconnect slow readers; reconnect gets a complete snapshot.
			close(c)
			delete(h.clients, c)
		}
	}
}
func (h *Hub) subscribe() chan streamEvent {
	h.mu.Lock()
	defer h.mu.Unlock()
	c := make(chan streamEvent, 16)
	h.clients[c] = true
	return c
}
func (h *Hub) remove(c chan streamEvent) { h.mu.Lock(); delete(h.clients, c); h.mu.Unlock() }

type Server struct {
	sampler  *Sampler
	svc      *ServiceManager
	security *Security
	history  *HistoryStore
	alerter  *Alerter
	hub      *Hub
	docker   *DockerClient
	mu       sync.RWMutex
	services []ServiceInfo
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func (s *Server) serviceSnapshot() []ServiceInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]ServiceInfo{}, s.services...)
}
func (s *Server) collectServices(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	list := s.svc.List(ctx)
	s.mu.Lock()
	s.services = list
	s.mu.Unlock()
	s.hub.Publish("services", list)
}
func (s *Server) background(ctx context.Context) {
	s.collectServices(ctx)
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.collectServices(ctx)
		}
	}
}
func (s *Server) backgroundDocker(ctx context.Context) {
	for {
		c, cancel := context.WithTimeout(ctx, 10*time.Second)
		s.docker.Collect(c)
		cancel()
		s.hub.Publish("containers", s.docker.Snapshot())
		if !waitContext(ctx, 5*time.Second) {
			return
		}
	}
}
func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	if _, ok := w.(http.Flusher); !ok {
		writeAPIError(w, 500, "stream_unavailable", "stream unavailable")
		return
	}
	c := s.hub.subscribe()
	defer s.hub.remove(c)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	rc := http.NewResponseController(w)
	send := func(name string, b []byte) error {
		_ = rc.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if _, e := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, b); e != nil {
			return e
		}
		return rc.Flush()
	}
	fmt.Fprint(w, "retry: 2000\n\n")
	for _, v := range []struct {
		name string
		data any
	}{{"overview", s.sampler.Overview()}, {"processes", s.sampler.Processes("cpu", 0)}, {"services", s.serviceSnapshot()}, {"alerts", s.alerter.Snapshot()}, {"containers", s.docker.Snapshot()}} {
		b, _ := json.Marshal(v.data)
		if send(v.name, b) != nil {
			return
		}
	}
	keep := time.NewTicker(2 * time.Second)
	defer keep.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case e, ok := <-c:
			if !ok {
				return
			}
			if send(e.Name, e.Data) != nil {
				return
			}
		case <-keep.C:
			if s.security.role(r) == "" {
				send("auth", []byte(`{"error":"session expired"}`))
				return
			}
			if send("heartbeat", []byte(`{}`)) != nil {
				return
			}
		}
	}
}
func (s *Server) audited(w http.ResponseWriter, r *http.Request, fn func() (any, error)) {
	role, _ := r.Context().Value(roleKey{}).(string)
	action := r.Method + " " + r.URL.RequestURI()
	if e := s.security.audit(r, role, action, "requested"); e != nil {
		writeAPIError(w, 503, "audit_unavailable", "审计日志不可写，操作未执行")
		return
	}
	v, e := fn()
	result := "ok"
	if e != nil {
		result = e.Error()
	}
	if err := s.security.audit(r, role, action, result); err != nil {
		log.Printf("审计结果写入失败: %v", err)
	}
	if e != nil {
		writeAPIError(w, 400, errorCode(e, "operation_failed"), e.Error())
		return
	}
	writeJSON(w, 200, v)
}
func (s *Server) routes() http.Handler {
	api := http.NewServeMux()
	api.HandleFunc("GET /api/ping", func(w http.ResponseWriter, r *http.Request) {
		role, _ := r.Context().Value(roleKey{}).(string)
		writeJSON(w, 200, map[string]any{"ok": true, "role": role, "auth": s.security.token != "", "persistent": s.history.dir != ""})
	})
	api.HandleFunc("POST /api/logout", s.security.Logout)
	api.HandleFunc("GET /api/overview", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, s.sampler.Overview()) })
	api.HandleFunc("GET /api/processes", func(w http.ResponseWriter, r *http.Request) {
		n := 40
		if r.URL.Query().Get("limit") == "all" {
			n = 0
		}
		writeJSON(w, 200, s.sampler.Processes(r.URL.Query().Get("sort"), n))
	})
	api.HandleFunc("GET /api/processes/{pid}", func(w http.ResponseWriter, r *http.Request) {
		pid, e := strconv.ParseInt(r.PathValue("pid"), 10, 32)
		if e != nil || pid <= 0 {
			writeAPIError(w, 400, "invalid_pid", "invalid PID")
			return
		}
		p, e := process.NewProcess(int32(pid))
		if e != nil {
			writeAPIError(w, 404, "process_unavailable", "process unavailable")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		cmd, ce := p.CmdlineWithContext(ctx)
		for _, secret := range []string{s.security.token, s.security.view} {
			if secret != "" {
				cmd = strings.ReplaceAll(cmd, secret, "[redacted]")
			}
		}
		cwd, we := p.CwdWithContext(ctx)
		created, te := p.CreateTimeWithContext(ctx)
		threads, ne := p.NumThreadsWithContext(ctx)
		files, fe := p.OpenFilesWithContext(ctx)
		unavailable := []string{}
		for key, err := range map[string]error{"command": ce, "cwd": we, "created": te, "threads": ne, "openFiles": fe} {
			if err != nil {
				unavailable = append(unavailable, key)
			}
		}
		writeJSON(w, 200, map[string]any{"pid": pid, "command": cmd, "cwd": cwd, "created": created, "threads": threads, "openFiles": len(files), "unavailable": unavailable})
	})
	api.HandleFunc("POST /api/processes/{pid}/kill", func(w http.ResponseWriter, r *http.Request) {
		s.audited(w, r, func() (any, error) {
			pid, e := strconv.ParseInt(r.PathValue("pid"), 10, 32)
			if e != nil || pid <= 1 || pid == int64(os.Getpid()) {
				return nil, codedError("protected_pid", "拒绝操作受保护 PID")
			}
			sig := r.URL.Query().Get("signal")
			if sig == "" {
				sig = "TERM"
			}
			if sig != "TERM" && sig != "KILL" {
				return nil, codedError("invalid_signal", "signal 必须为 TERM 或 KILL")
			}
			p, e := process.NewProcess(int32(pid))
			if e != nil {
				return nil, codedError("process_unavailable", e.Error())
			}
			expected, _ := strconv.ParseInt(r.URL.Query().Get("created"), 10, 64)
			actual, e := p.CreateTime()
			if e != nil || expected == 0 || expected != actual {
				return nil, codedError("process_changed", "进程已变化，请重新打开详情后操作")
			}
			signal := syscall.SIGTERM
			if sig == "KILL" {
				signal = syscall.SIGKILL
			}
			e = p.SendSignal(signal)
			if e != nil {
				e = codedError("process_control_failed", e.Error())
			}
			return map[string]bool{"ok": e == nil}, e
		})
	})
	api.HandleFunc("GET /api/services", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, s.serviceSnapshot()) })
	api.HandleFunc("GET /api/services/{name}/logs", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		if !s.svc.isAllowed(name) {
			writeAPIError(w, 403, "service_not_allowed", "service not allowed")
			return
		}
		n := 200
		if x, e := strconv.Atoi(r.URL.Query().Get("n")); e == nil {
			n = max(1, min(1000, x))
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		out, e := exec.CommandContext(ctx, "journalctl", "-u", name, "-n", strconv.Itoa(n), "--no-pager", "-o", "short-iso").Output()
		if e != nil {
			writeAPIError(w, 503, "logs_unavailable", "journalctl 不可用或权限不足")
			return
		}
		writeJSON(w, 200, map[string]string{"logs": string(out)})
	})
	api.HandleFunc("POST /api/services/{name}/{action}", func(w http.ResponseWriter, r *http.Request) {
		s.audited(w, r, func() (any, error) {
			name, act := r.PathValue("name"), r.PathValue("action")
			if e := s.svc.Control(r.Context(), name, act); e != nil {
				return nil, e
			}
			s.collectServices(r.Context())
			return s.svc.Status(r.Context(), name), nil
		})
	})
	api.HandleFunc("GET /api/history", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		ran := q.Get("range")
		if ran == "" {
			ran = "3m"
		}
		if _, ok := historyRanges[ran]; !ok {
			writeAPIError(w, 400, "invalid_range", "invalid range")
			return
		}
		key := q.Get("iface")
		if len(key) > 128 {
			writeAPIError(w, 400, "invalid_interface", "invalid interface")
			return
		}
		if key != "" {
			found := false
			for _, n := range s.sampler.Overview().Interfaces {
				if n.Name == key {
					found = true
				}
			}
			if !found {
				writeAPIError(w, 404, "unknown_interface", "unknown interface")
				return
			}
		}
		writeJSON(w, 200, s.history.Get(key, ran, time.Now()))
	})
	api.HandleFunc("GET /api/alerts", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, s.alerter.Snapshot()) })
	api.HandleFunc("GET /api/stream", s.stream)
	api.HandleFunc("GET /api/containers", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, s.docker.Snapshot()) })
	api.HandleFunc("POST /api/containers/{id}/{action}", func(w http.ResponseWriter, r *http.Request) {
		s.audited(w, r, func() (any, error) {
			e := s.docker.Control(r.Context(), r.PathValue("id"), r.PathValue("action"))
			return map[string]bool{"ok": e == nil}, e
		})
	})
	sub, _ := fs.Sub(webFS, "web")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", s.security.Login)
	mux.Handle("/api/", s.security.auth(api))
	mux.Handle("/", http.FileServerFS(sub))
	return securityHeaders(mux)
}
