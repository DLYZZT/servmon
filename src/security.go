package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type session struct {
	Role  string
	Until time.Time
}
type failure struct {
	Count int
	Level uint
	Until time.Time
	Seen  time.Time
}
type Security struct {
	mu          sync.Mutex
	token, view string
	sessions    map[[32]byte]session
	failures    map[string]*failure
	dir         string
}
type roleKey struct{}

func newSecurity(c Config) *Security {
	return &Security{token: c.Token, view: c.ViewToken, sessions: map[[32]byte]session{}, failures: map[string]*failure{}, dir: c.DataDir}
}
func clientIP(r *http.Request) string {
	ip, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		return r.RemoteAddr
	}
	return ip
}
func (s *Security) tokenRole(token string) string {
	if s.token == "" {
		return "admin"
	}
	if subtle.ConstantTimeCompare([]byte(token), []byte(s.token)) == 1 {
		return "admin"
	}
	if s.view != "" && subtle.ConstantTimeCompare([]byte(token), []byte(s.view)) == 1 {
		return "view"
	}
	return ""
}
func (s *Security) limited(ip string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if f := s.failures[ip]; f != nil && time.Now().Before(f.Until) {
		return int(time.Until(f.Until).Seconds()) + 1
	}
	return 0
}
func (s *Security) fail(ip string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for k, f := range s.failures {
		if now.Sub(f.Seen) > 24*time.Hour {
			delete(s.failures, k)
		}
	}
	if len(s.failures) >= 10000 {
		return
	}
	f := s.failures[ip]
	if f == nil {
		f = &failure{}
		s.failures[ip] = f
	}
	f.Count++
	f.Seen = now
	if f.Count >= 5 {
		d := time.Minute * time.Duration(1<<min(f.Level, 6))
		if d > time.Hour {
			d = time.Hour
		}
		f.Until = now.Add(d)
		f.Level++
		f.Count = 0
	}
}
func (s *Security) throttle(w http.ResponseWriter, r *http.Request) bool {
	if n := s.limited(clientIP(r)); n > 0 {
		w.Header().Set("Retry-After", fmt.Sprint(n))
		writeJSON(w, 429, map[string]string{"error": "登录尝试过多，请稍后重试"})
		return true
	}
	return false
}
func sameOrigin(r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, e := url.Parse(origin)
		return e == nil && u.Host == r.Host
	}
	return true
}
func (s *Security) Login(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeJSON(w, 403, map[string]string{"error": "invalid origin"})
		return
	}
	if s.throttle(w, r) {
		return
	}
	var b struct {
		Token string `json:"token"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&b) != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid login"})
		return
	}
	role := s.tokenRole(b.Token)
	if role == "" {
		s.fail(clientIP(r))
		writeJSON(w, 401, map[string]string{"error": "unauthorized"})
		return
	}
	buf := make([]byte, 32)
	if _, e := rand.Read(buf); e != nil {
		writeJSON(w, 500, map[string]string{"error": "session unavailable"})
		return
	}
	token := hex.EncodeToString(buf)
	s.mu.Lock()
	for k, v := range s.sessions {
		if time.Now().After(v.Until) {
			delete(s.sessions, k)
		}
	}
	if len(s.sessions) >= 10000 {
		s.mu.Unlock()
		writeJSON(w, 503, map[string]string{"error": "too many sessions"})
		return
	}
	s.sessions[sha256.Sum256([]byte(token))] = session{role, time.Now().Add(24 * time.Hour)}
	delete(s.failures, clientIP(r))
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "servmon_session", Value: token, Path: "/", HttpOnly: true, Secure: r.TLS != nil, SameSite: http.SameSiteStrictMode, MaxAge: 86400})
	writeJSON(w, 200, map[string]string{"role": role})
}
func (s *Security) Logout(w http.ResponseWriter, r *http.Request) {
	if c, e := r.Cookie("servmon_session"); e == nil {
		s.mu.Lock()
		delete(s.sessions, sha256.Sum256([]byte(c.Value)))
		s.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: "servmon_session", Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil, MaxAge: -1})
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (s *Security) role(r *http.Request) string {
	if s.token == "" {
		return "admin"
	}
	if h := r.Header.Get("Authorization"); h != "" {
		if !strings.HasPrefix(h, "Bearer ") {
			return ""
		}
		return s.tokenRole(strings.TrimPrefix(h, "Bearer "))
	}
	if c, e := r.Cookie("servmon_session"); e == nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		v, ok := s.sessions[sha256.Sum256([]byte(c.Value))]
		if ok && time.Now().Before(v.Until) {
			return v.Role
		}
	}
	return ""
}
func (s *Security) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.throttle(w, r) {
			return
		}
		role := s.role(r)
		if role == "" {
			if r.Header.Get("Authorization") != "" {
				s.fail(clientIP(r))
			}
			writeJSON(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			if !sameOrigin(r) {
				writeJSON(w, 403, map[string]string{"error": "invalid origin"})
				return
			}
			if role != "admin" && r.URL.Path != "/api/logout" {
				s.audit(r, role, r.URL.Path, "forbidden")
				writeJSON(w, 403, map[string]string{"error": "只读令牌不能执行此操作"})
				return
			}
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), roleKey{}, role)))
	})
}
func (s *Security) audit(r *http.Request, role, action, result string) error {
	entry := map[string]any{"time": time.Now().UTC(), "ip": clientIP(r), "role": role, "action": action, "result": result}
	b, _ := json.Marshal(entry)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dir == "" {
		return fmt.Errorf("audit storage unavailable")
	}
	f, e := os.OpenFile(filepath.Join(s.dir, "audit.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer f.Close()
	_, e = f.Write(append(b, '\n'))
	return e
}
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}
