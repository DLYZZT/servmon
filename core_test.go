package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/shirou/gopsutil/v3/process"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestConfig(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.yaml")
	os.WriteFile(p, []byte("token: admin\nview_token: reader\ninterval: 500ms\nproc_interval: 3s\nservices: [nginx, sshd]\nalerts:\n  cpu: 90\n  sustain: 2s\nnotify:\n  webhook: https://example.test/hook\n"), 0600)
	c, e := loadConfig(p)
	if e != nil || c.validate() != nil || c.Alerts.Sustain != 2*time.Second || c.Alerts.Cooldown != 10*time.Minute || len(c.Notify.Webhook) != 1 {
		t.Fatalf("config=%+v error=%v", c, e)
	}
	c.Services = []string{"--help"}
	if c.validate() == nil {
		t.Fatal("option injection accepted")
	}
	c.Services = nil
	c.ViewToken = c.Token
	if c.validate() == nil {
		t.Fatal("identical tokens")
	}
	c.ViewToken = ""
	c.Interval = 0
	if c.validate() == nil {
		t.Fatal("zero interval")
	}
}
func TestAlertStateMachine(t *testing.T) {
	now := time.Unix(1700000000, 0)
	var events []AlertEvent
	a := NewAlerter(AlertConfig{CPU: 90, Disk: 90, ServiceFailed: true, Sustain: 30 * time.Second, Cooldown: time.Minute}, func(e AlertEvent) { events = append(events, e) })
	o := Overview{Host: "test", Current: Sample{CPU: 95}, Disks: []DiskInfo{{Mount: "/", Percent: 95}}}
	a.Evaluate(o, nil, now)
	a.Evaluate(o, nil, now.Add(29*time.Second))
	if len(events) != 0 {
		t.Fatal("premature firing")
	}
	o.Current.CPU = 20
	a.Evaluate(o, nil, now.Add(30*time.Second))
	if len(events) != 1 || events[0].Rule != "disk:/" {
		t.Fatalf("events %+v", events)
	}
	o.Current.CPU = 95
	a.Evaluate(o, nil, now.Add(31*time.Second))
	a.Evaluate(o, nil, now.Add(61*time.Second))
	if len(a.Snapshot().Active) != 2 {
		t.Fatal("sustain should restart after recovery")
	}
	a.Evaluate(o, nil, now.Add(70*time.Second))
	if len(events) != 2 {
		t.Fatal("cooldown ignored")
	}
	a.Evaluate(o, nil, now.Add(95*time.Second))
	if len(events) != 3 {
		t.Fatal("reminder absent")
	}
	o.Current.CPU = 0
	o.Disks[0].Percent = 0
	a.Evaluate(o, nil, now.Add(96*time.Second))
	if len(a.Snapshot().Active) != 0 || events[len(events)-1].State != "resolved" {
		t.Fatal("recovery absent")
	}
	if !strings.Contains(events[len(events)-1].Message, "after") {
		t.Fatal("no duration")
	}
}
func TestServiceAlertUnknownDoesNotResolve(t *testing.T) {
	a := NewAlerter(AlertConfig{ServiceFailed: true, Cooldown: time.Minute}, nil)
	now := time.Now()
	a.Evaluate(Overview{}, []ServiceInfo{{Name: "nginx", Active: "failed"}}, now)
	a.Evaluate(Overview{}, []ServiceInfo{{Name: "nginx", Active: "unknown"}}, now.Add(time.Second))
	if len(a.Snapshot().Active) != 1 {
		t.Fatal("unknown resolved alert")
	}
	a.Evaluate(Overview{}, []ServiceInfo{{Name: "nginx", Active: "active"}}, now.Add(2*time.Second))
	if len(a.Snapshot().Active) != 0 {
		t.Fatal("did not resolve")
	}
}
func TestHistoryPersistenceAndResolution(t *testing.T) {
	dir := t.TempDir()
	h := NewHistory(dir)
	base := time.Unix(1700000400, 0)
	for i := 0; i < 1800; i++ {
		h.Add("", Sample{T: base.Add(time.Duration(i) * 2 * time.Second).Unix(), CPU: float64(i%2) * 100, RxBps: 100, Disk: 75})
		h.Add("eth0", Sample{T: base.Add(time.Duration(i) * 2 * time.Second).Unix(), RxBps: 200})
	}
	h.Flush()
	restored := NewHistory(dir)
	rows := restored.Get("", "24h", base.Add(time.Hour))
	if len(rows) != 60 || rows[0].CPU != 50 || rows[0].Disk != 75 {
		t.Fatalf("restored %d rows, first=%+v", len(rows), rows[0])
	}
	if got := restored.Get("eth0", "24h", base.Add(time.Hour)); len(got) != 60 || got[0].RxBps != 200 {
		t.Fatal("interface history lost")
	}
	if got := restored.Get("", "7d", base.Add(time.Hour)); len(got) != 6 {
		t.Fatalf("10m resolution=%d", len(got))
	}
	info, _ := os.Stat(h.path("", 60))
	if info.Size() != 8+60*48 {
		t.Fatal("record size")
	}
	if len(restored.Get("", "24h", base.Add(48*time.Hour))) != 0 {
		t.Fatal("stale rows")
	}
}
func TestHistoryRingAndCorruption(t *testing.T) {
	h := NewHistory("")
	base := time.Unix(1700000400, 0)
	for i := 0; i < 1500; i++ {
		h.Add("", Sample{T: base.Add(time.Duration(i) * time.Minute).Unix(), CPU: float64(i)})
	}
	h.Flush()
	if len(h.tiers[""][0].Rows) != 1440 {
		t.Fatal("unbounded ring")
	}
	dir := t.TempDir()
	h = NewHistory(dir)
	os.WriteFile(h.path("", 60), []byte("broken"), 0600)
	h = NewHistory(dir)
	if len(h.Get("", "24h", base)) != 0 {
		t.Fatal("corrupt history loaded")
	}
	h = NewHistory(filepath.Join(dir, "missing", "dir"))
	h.Add("", Sample{T: base.Unix()})
	h.Flush()
	if len(h.Get("", "24h", base)) != 1 {
		t.Fatal("fallback data lost")
	}
}
func TestNotifierRecoveryAndSpool(t *testing.T) {
	var requests atomic.Int32
	var received AlertEvent
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			w.WriteHeader(503)
			return
		}
		if r.Header.Get("X-Servmon-Event") != "firing" {
			t.Error("missing routing header")
		}
		json.NewDecoder(r.Body).Decode(&received)
		w.WriteHeader(204)
	}))
	defer receiver.Close()
	cfg := NotifyConfig{Webhook: []string{receiver.URL}}
	dir := t.TempDir()
	n := NewNotifier(cfg, dir)
	n.Enqueue(AlertEvent{Host: "test", Rule: "cpu", State: "firing", Value: 95})
	n.Flush()
	n = NewNotifier(cfg, dir)
	if len(n.queue) != 1 {
		t.Fatal("queue not restored")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { n.Run(ctx); close(done) }()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		n.mu.Lock()
		empty := len(n.queue) == 0
		n.mu.Unlock()
		if empty {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	if requests.Load() != 2 || received.Rule != "cpu" {
		t.Fatal("failed delivery was lost")
	}
	if len(NewNotifier(cfg, dir).queue) != 0 {
		t.Fatal("delivered event retained")
	}
}
func testServer(t *testing.T) *Server {
	t.Helper()
	c := defaultConfig()
	c.Token = "admin-test"
	c.ViewToken = "view-test"
	c.DataDir = t.TempDir()
	return &Server{sampler: NewSampler(time.Second), svc: &ServiceManager{allowed: []string{"nginx"}}, security: newSecurity(c), history: NewHistory(c.DataDir), alerter: NewAlerter(c.Alerts, nil), hub: NewHub(), docker: NewDocker("/no/socket")}
}
func request(s *Server, method, path, token, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:1234"
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	s.routes().ServeHTTP(w, r)
	return w
}
func TestAuthRolesCookiesAndHeaders(t *testing.T) {
	s := testServer(t)
	w := request(s, "GET", "/api/overview", "", "")
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
	w = request(s, "POST", "/api/login", "", `{"token":"view-test"}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatal("unsafe cookie")
	}
	r := httptest.NewRequest("GET", "/api/ping", nil)
	r.AddCookie(cookies[0])
	w = httptest.NewRecorder()
	s.routes().ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"role":"view"`) {
		t.Fatal(w.Body.String())
	}
	for _, path := range []string{"/api/services/nginx/stop", "/api/processes/123/kill", "/api/containers/id/stop"} {
		if w = request(s, "POST", path, "view-test", ""); w.Code != 403 {
			t.Fatal(path, w.Code)
		}
	}
	w = request(s, "GET", "/", "", "")
	if w.Header().Get("X-Frame-Options") != "DENY" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "script-src 'self'") {
		t.Fatal("headers absent")
	}
	r = httptest.NewRequest("POST", "https://example.test/api/login", strings.NewReader(`{"token":"admin-test"}`))
	w = httptest.NewRecorder()
	s.routes().ServeHTTP(w, r)
	if !w.Result().Cookies()[0].Secure {
		t.Fatal("TLS cookie lacks Secure")
	}
	r = httptest.NewRequest("POST", "/api/logout", nil)
	r.AddCookie(cookies[0])
	w = httptest.NewRecorder()
	s.routes().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	r = httptest.NewRequest("GET", "/api/ping", nil)
	r.AddCookie(cookies[0])
	w = httptest.NewRecorder()
	s.routes().ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("logout session still valid")
	}
}
func TestLoginBackoff(t *testing.T) {
	s := testServer(t)
	for i := 0; i < 5; i++ {
		w := request(s, "POST", "/api/login", "", `{"token":"wrong"}`)
		if w.Code != 401 {
			t.Fatal(w.Code)
		}
	}
	w := request(s, "POST", "/api/login", "", `{"token":"admin-test"}`)
	if w.Code != 429 || w.Header().Get("Retry-After") == "" {
		t.Fatal("not throttled")
	}
	s.security.mu.Lock()
	s.security.failures["127.0.0.1"].Until = time.Now().Add(-time.Second)
	s.security.mu.Unlock()
	for i := 0; i < 5; i++ {
		request(s, "POST", "/api/login", "", `{"token":"wrong"}`)
	}
	if s.security.limited("127.0.0.1") < 119 {
		t.Fatal("backoff did not grow")
	}
}
func TestProtectedOperationsAndAudit(t *testing.T) {
	s := testServer(t)
	for _, pid := range []string{"1", "0", "-1", strconvI(os.Getpid())} {
		w := request(s, "POST", "/api/processes/"+pid+"/kill?signal=TERM", "admin-test", "")
		if w.Code != 400 {
			t.Fatal(pid, w.Code)
		}
	}
	b, e := os.ReadFile(filepath.Join(s.security.dir, "audit.log"))
	if e != nil || !strings.Contains(string(b), "拒绝操作受保护 PID") {
		t.Fatal("audit absent")
	}
	s.security.dir = ""
	if w := request(s, "POST", "/api/services/nginx/stop", "admin-test", ""); w.Code != 503 {
		t.Fatal("operation without audit")
	}
	r := httptest.NewRequest("POST", "/api/services/nginx/stop", nil)
	r.Header.Set("Authorization", "Bearer admin-test")
	r.Header.Set("Origin", "https://attacker.invalid")
	w := httptest.NewRecorder()
	s.routes().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross origin mutation accepted")
	}
}
func strconvI(n int) string { b, _ := json.Marshal(n); return string(b) }
func TestStreamSnapshot(t *testing.T) {
	s := testServer(t)
	s.security.token = ""
	ts := httptest.NewServer(s.routes())
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	r, _ := http.NewRequestWithContext(ctx, "GET", ts.URL+"/api/stream", nil)
	resp, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	b := make([]byte, 8192)
	n, e := resp.Body.Read(b)
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(string(b[:n]), "event: overview") || resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatal(string(b[:n]))
	}
}
func TestCachedProcesses(t *testing.T) {
	s := NewSampler(time.Second)
	s.procCache = []ProcInfo{{PID: 1, CPU: 10, RSS: 100}, {PID: 2, CPU: 20, RSS: 50}}
	a := s.Processes("cpu", 1)
	b := s.Processes("mem", 0)
	if a[0].PID != 2 || b[0].PID != 1 {
		t.Fatal("sort/cache")
	}
	a[0].Name = "mutated"
	if s.procCache[1].Name != "" {
		t.Fatal("cache mutated")
	}
}
func BenchmarkCachedProcesses(b *testing.B) {
	s := NewSampler(time.Second)
	for i := 0; i < 500; i++ {
		s.procCache = append(s.procCache, ProcInfo{PID: int32(i), CPU: float64(500 - i)})
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		s.Processes("cpu", 0)
	}
}
func TestDockerAPI(t *testing.T) {
	var control atomic.Bool
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/containers/json":
			io.WriteString(w, `[{"Id":"abc","Names":["/web"],"Image":"nginx","State":"running"}]`)
		case "/containers/abc/stats":
			io.WriteString(w, `{"cpu_stats":{"cpu_usage":{"total_usage":200},"system_cpu_usage":1000,"online_cpus":2},"precpu_stats":{"cpu_usage":{"total_usage":100},"system_cpu_usage":500},"memory_stats":{"usage":1024,"stats":{"inactive_file":24}}}`)
		case "/containers/abc/stop":
			control.Store(true)
			w.WriteHeader(204)
		default:
			w.WriteHeader(404)
		}
	}))
	defer ts.Close()
	d := NewDocker("")
	d.client = &http.Client{Transport: rewriteTransport{base: ts.URL}}
	d.Collect(context.Background())
	v := d.Snapshot()
	if !v.Available || len(v.Containers) != 1 || v.Containers[0].CPU != 40 || v.Containers[0].Memory != 1000 {
		t.Fatalf("%+v", v)
	}
	if e := d.Control(context.Background(), "abc", "stop"); e != nil || !control.Load() {
		t.Fatal(e)
	}
	if d.Control(context.Background(), "unknown", "stop") == nil {
		t.Fatal("unknown container")
	}
}

type rewriteTransport struct{ base string }

func (rt rewriteTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r.URL.Scheme = "http"
	r.URL.Host = strings.TrimPrefix(rt.base, "http://")
	return http.DefaultTransport.RoundTrip(r)
}

func TestOwnProcessTokenRedaction(t *testing.T) {
	s := testServer(t)
	// The test binary's argv includes its filename, used as a synthetic secret.
	s.security.token = filepath.Base(os.Args[0])
	r := httptest.NewRequest("GET", "/api/processes/"+strconvI(os.Getpid()), nil)
	r.Header.Set("Authorization", "Bearer view-test")
	w := httptest.NewRecorder()
	s.routes().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if strings.Contains(w.Body.String(), s.security.token) {
		t.Fatal("configured secret leaked through command line")
	}
}

func TestNotifierIndependentChannels(t *testing.T) {
	var good atomic.Int32
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer bad.Close()
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { good.Add(1); w.WriteHeader(204) }))
	defer ok.Close()
	n := NewNotifier(NotifyConfig{Webhook: []string{bad.URL, ok.URL}}, t.TempDir())
	n.Enqueue(AlertEvent{State: "firing"})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { n.Run(ctx); close(done) }()
	deadline := time.Now().Add(2 * time.Second)
	for good.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	if good.Load() != 1 {
		t.Fatal("offline channel blocked healthy target")
	}
	n.Flush()
	if len(NewNotifier(n.cfg, filepath.Dir(n.path)).queue) != 1 {
		t.Fatal("offline channel dropped")
	}
}

func TestKillOwnedChild(t *testing.T) {
	child := exec.Command("sleep", "60")
	if e := child.Start(); e != nil {
		t.Fatal(e)
	}
	defer child.Process.Kill()
	p, e := process.NewProcess(int32(child.Process.Pid))
	if e != nil {
		t.Fatal(e)
	}
	created, e := p.CreateTime()
	if e != nil {
		t.Fatal(e)
	}
	s := testServer(t)
	path := fmt.Sprintf("/api/processes/%d/kill?signal=TERM&created=%d", child.Process.Pid, created)
	if w := request(s, "POST", path, "view-test", ""); w.Code != 403 {
		t.Fatal("read-only kill allowed")
	}
	if w := request(s, "POST", path+"1", "admin-test", ""); w.Code != 400 {
		t.Fatal("PID reuse identity accepted")
	}
	if w := request(s, "POST", path, "admin-test", ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("TERM not delivered")
	}
}

func TestServiceControlAndLogsWithFakeCommands(t *testing.T) {
	dir := t.TempDir()
	script := "#!/bin/sh\nif [ \"$1\" = show ]; then\nprintf 'ActiveState=active\\nSubState=running\\nDescription=Test service\\nUnitFileState=enabled\\n'\nelse\nexit 0\nfi\n"
	if e := os.WriteFile(filepath.Join(dir, "systemctl"), []byte(script), 0700); e != nil {
		t.Fatal(e)
	}
	os.WriteFile(filepath.Join(dir, "journalctl"), []byte("#!/bin/sh\nprintf '2026-09-16T10:00:00 test log\\n'\n"), 0700)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	s := testServer(t)
	for _, action := range []string{"start", "stop", "restart", "enable", "disable"} {
		w := request(s, "POST", "/api/services/nginx/"+action, "admin-test", "")
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"active":"active"`) {
			t.Fatal(action, w.Body.String())
		}
	}
	if w := request(s, "POST", "/api/services/other/stop", "admin-test", ""); w.Code != 400 {
		t.Fatal("allowlist bypass")
	}
	if w := request(s, "GET", "/api/services/nginx/logs?n=200", "view-test", ""); w.Code != 200 || !strings.Contains(w.Body.String(), "test log") {
		t.Fatal(w.Body.String())
	}
	if w := request(s, "GET", "/api/services/other/logs", "admin-test", ""); w.Code != 403 {
		t.Fatal("logs allowlist bypass")
	}
}

func TestSamplerConcurrentSnapshots(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := NewSampler(250 * time.Millisecond)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); s.Run(ctx) }()
	go func() { defer wg.Done(); s.RunProcesses(ctx, time.Second, nil) }()
	deadline := time.Now().Add(1400 * time.Millisecond)
	for time.Now().Before(deadline) {
		if _, e := json.Marshal(s.Overview()); e != nil {
			t.Error(e)
		}
		s.Processes("mem", 40)
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	wg.Wait()
	o := s.Overview()
	if o.Current.T == 0 || o.Cores < 1 || len(o.History) == 0 {
		t.Fatalf("no real samples: %+v", o)
	}
	for _, n := range o.Interfaces {
		if n.Rx < 0 || n.Tx < 0 {
			t.Fatal("negative network rate")
		}
	}
	if counterRate(1, 2, 1) != 0 || counterRate(4, 2, 0) != 0 || counterRate(4, 2, 2) != 1 {
		t.Fatal("counter reset handling")
	}
}
