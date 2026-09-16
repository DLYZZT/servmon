// servmon — 单文件个人服务器监控面板
//
// 构建:  go build -ldflags="-s -w" -o servmon .
// 运行:  sudo ./servmon -addr :8080 -token 你的密码 -services nginx,docker,sshd
package main

import (
	"context"
	"crypto/subtle"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/load"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
	"gopkg.in/yaml.v3"
)

//go:embed web
var webFS embed.FS

const historyLen = 90 // 保留的采样点数（2s 间隔 ≈ 3 分钟）

// 不展示的文件系统类型（伪文件系统 / 镜像挂载）
var skipFS = map[string]bool{"squashfs": true, "devfs": true, "devtmpfs": true, "tmpfs": true, "overlay": true, "autofs": true, "fuse.snapfuse": true}

// ---------- 数据结构 ----------

type Sample struct {
	T     int64   `json:"t"`   // unix 秒
	CPU   float64 `json:"cpu"` // 总 CPU %
	Mem   float64 `json:"mem"` // 内存 %
	RxBps float64 `json:"rx"`  // 下行 bytes/s
	TxBps float64 `json:"tx"`  // 上行 bytes/s
	Load1 float64 `json:"load1"`
}

type DiskInfo struct {
	Mount   string  `json:"mount"`
	FS      string  `json:"fs"`
	Total   uint64  `json:"total"`
	Used    uint64  `json:"used"`
	Percent float64 `json:"percent"`
}

type Overview struct {
	Host      string     `json:"host"`
	OS        string     `json:"os"`
	Kernel    string     `json:"kernel"`
	Uptime    uint64     `json:"uptime"`
	Cores     int        `json:"cores"`    // 逻辑核
	Physical  int        `json:"physical"` // 物理核（取不到时为 0）
	CPUModel  string     `json:"cpuModel"`
	CPUMhz    float64    `json:"cpuMhz"`
	Temp      float64    `json:"temp"` // CPU 温度 °C，取不到时为 0
	PerCore   []float64  `json:"perCore"`
	Load      [3]float64 `json:"load"`
	MemTotal  uint64     `json:"memTotal"`
	MemUsed   uint64     `json:"memUsed"`
	MemCached uint64     `json:"memCached"`
	SwapTotal uint64     `json:"swapTotal"`
	SwapUsed  uint64     `json:"swapUsed"`
	Disks     []DiskInfo `json:"disks"`
	NetIface  string     `json:"netIface"`
	NetRxTot  uint64     `json:"netRxTotal"`
	NetTxTot  uint64     `json:"netTxTotal"`
	ProcCount int        `json:"procCount"`
	Interval  float64    `json:"interval"` // 采样间隔（秒）
	Current   Sample     `json:"current"`
	History   []Sample   `json:"history"`
}

type ProcInfo struct {
	PID    int32   `json:"pid"`
	Name   string  `json:"name"`
	User   string  `json:"user"`
	CPU    float64 `json:"cpu"`
	MemPct float32 `json:"memPct"`
	RSS    uint64  `json:"rss"`
	Status string  `json:"status"`
}

type ServiceInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Active      string `json:"active"`  // active / inactive / failed / unknown
	Sub         string `json:"sub"`     // running / dead / exited ...
	Enabled     string `json:"enabled"` // enabled / disabled / static / ...
	Since       uint64 `json:"since"`   // 处于当前 active 状态的秒数，0 表示未知
}

// ---------- 采样器 ----------

type Sampler struct {
	mu        sync.RWMutex
	history   []Sample
	perCore   []float64
	lastNet   net.IOCountersStat
	lastT     time.Time
	iface     string
	cpuModel  string
	cpuMhz    float64
	physical  int
	temp      float64
	procCount int
	procs     map[int32]*process.Process
	interval  time.Duration
}

// netCounters 汇总物理网卡流量（跳过 lo 和 docker/veth/bridge 等虚拟接口），并返回流量最大的接口名
func netCounters() (net.IOCountersStat, string, bool) {
	list, err := net.IOCounters(true)
	if err != nil || len(list) == 0 {
		return net.IOCountersStat{}, "", false
	}
	var sum net.IOCountersStat
	var best string
	var bestBytes uint64
	for _, n := range list {
		if n.Name == "lo" || strings.HasPrefix(n.Name, "veth") || strings.HasPrefix(n.Name, "docker") ||
			strings.HasPrefix(n.Name, "br-") || strings.HasPrefix(n.Name, "virbr") {
			continue
		}
		sum.BytesRecv += n.BytesRecv
		sum.BytesSent += n.BytesSent
		if b := n.BytesRecv + n.BytesSent; b > bestBytes || best == "" {
			best, bestBytes = n.Name, b
		}
	}
	return sum, best, true
}

// cpuTemp 从传感器里挑一个最像 CPU 的温度
func cpuTemp() float64 {
	ts, _ := host.SensorsTemperatures() // 部分传感器读不到时会同时返回 err 和结果，只看结果
	if len(ts) == 0 {
		return 0
	}
	prefer := []string{"coretemp_package", "k10temp_tctl", "k10temp_tdie", "cpu_thermal", "cpu-thermal", "acpitz", "coretemp", "soc_thermal"}
	for _, key := range prefer {
		for _, t := range ts {
			if t.Temperature > 0 && strings.Contains(strings.ToLower(t.SensorKey), key) {
				return t.Temperature
			}
		}
	}
	for _, t := range ts {
		if t.Temperature > 0 {
			return t.Temperature
		}
	}
	return 0
}

func NewSampler(interval time.Duration) *Sampler {
	return &Sampler{interval: interval, procs: map[int32]*process.Process{}}
}

func (s *Sampler) Run(ctx context.Context) {
	// 预热：让 cpu.Percent 有一个基准点
	_, _ = cpu.Percent(0, false)
	_, _ = cpu.Percent(0, true)
	if n, iface, ok := netCounters(); ok {
		s.lastNet, s.lastT, s.iface = n, time.Now(), iface
	}
	if info, err := cpu.Info(); err == nil && len(info) > 0 {
		s.cpuModel = strings.TrimSpace(info[0].ModelName)
	}
	if n, err := cpu.Counts(false); err == nil {
		s.physical = n
	}
	tick := time.NewTicker(s.interval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			s.collect()
		}
	}
}

func (s *Sampler) collect() {
	smp := Sample{T: time.Now().Unix()}
	if p, err := cpu.Percent(0, false); err == nil && len(p) > 0 {
		smp.CPU = p[0]
	}
	pc, _ := cpu.Percent(0, true)
	if vm, err := mem.VirtualMemory(); err == nil {
		smp.Mem = vm.UsedPercent
	}
	if l, err := load.Avg(); err == nil {
		smp.Load1 = l.Load1
	}
	n, iface, netOK := netCounters()
	now := time.Now()
	if netOK {
		dt := now.Sub(s.lastT).Seconds()
		if dt > 0 && !s.lastT.IsZero() && n.BytesRecv >= s.lastNet.BytesRecv && n.BytesSent >= s.lastNet.BytesSent {
			smp.RxBps = float64(n.BytesRecv-s.lastNet.BytesRecv) / dt
			smp.TxBps = float64(n.BytesSent-s.lastNet.BytesSent) / dt
		}
	}
	var mhz float64
	if info, err := cpu.Info(); err == nil && len(info) > 0 {
		mhz = info[0].Mhz
	}
	temp := cpuTemp()
	pids, _ := process.Pids()

	s.mu.Lock()
	if netOK {
		s.lastNet, s.lastT, s.iface = n, now, iface
	}
	s.cpuMhz, s.temp, s.procCount = mhz, temp, len(pids)
	s.perCore = pc
	s.history = append(s.history, smp)
	if len(s.history) > historyLen {
		s.history = s.history[len(s.history)-historyLen:]
	}
	s.mu.Unlock()
}

func (s *Sampler) Overview() Overview {
	o := Overview{Cores: runtime.NumCPU(), Interval: s.interval.Seconds()}
	if hi, err := host.Info(); err == nil {
		o.Host = hi.Hostname
		o.OS = strings.TrimSpace(hi.Platform + " " + hi.PlatformVersion)
		o.Kernel = hi.KernelVersion
		o.Uptime = hi.Uptime
	}
	if l, err := load.Avg(); err == nil {
		o.Load = [3]float64{l.Load1, l.Load5, l.Load15}
	}
	if vm, err := mem.VirtualMemory(); err == nil {
		o.MemTotal, o.MemUsed, o.MemCached = vm.Total, vm.Used, vm.Cached
	}
	if sw, err := mem.SwapMemory(); err == nil {
		o.SwapTotal, o.SwapUsed = sw.Total, sw.Used
	}
	if parts, err := disk.Partitions(false); err == nil {
		seen := map[string]bool{}
		for _, p := range parts {
			if strings.HasPrefix(p.Device, "/dev/loop") || skipFS[p.Fstype] || seen[p.Device] ||
				strings.HasPrefix(p.Mountpoint, "/System/Volumes/") { // macOS 的系统卷与 / 共享同一容器
				continue
			}
			u, err := disk.Usage(p.Mountpoint)
			if err != nil || u.Total == 0 {
				continue
			}
			seen[p.Device] = true
			o.Disks = append(o.Disks, DiskInfo{p.Mountpoint, p.Fstype, u.Total, u.Used, u.UsedPercent})
		}
	}
	s.mu.RLock()
	o.PerCore = append([]float64(nil), s.perCore...)
	o.History = append([]Sample(nil), s.history...)
	o.NetRxTot, o.NetTxTot, o.NetIface = s.lastNet.BytesRecv, s.lastNet.BytesSent, s.iface
	o.CPUModel, o.CPUMhz, o.Physical, o.Temp, o.ProcCount = s.cpuModel, s.cpuMhz, s.physical, s.temp, s.procCount
	s.mu.RUnlock()
	if len(o.History) > 0 {
		o.Current = o.History[len(o.History)-1]
	}
	return o
}

// Processes 返回按 CPU 或内存排序的前 limit 个进程
func (s *Sampler) Processes(sortBy string, limit int) []ProcInfo {
	list, err := process.Processes()
	if err != nil {
		return nil
	}
	s.mu.Lock()
	alive := map[int32]bool{}
	out := make([]ProcInfo, 0, len(list))
	for _, p := range list {
		alive[p.Pid] = true
		cached, ok := s.procs[p.Pid]
		pi := ProcInfo{PID: p.Pid}
		if !ok {
			cached = p
			s.procs[p.Pid] = p
			_, _ = cached.Percent(0) // 首次见到只建立基准，CPU 记 0，下一轮才有真实值
		} else {
			pi.CPU, _ = cached.Percent(0)
		}
		pi.Name, _ = cached.Name()
		pi.User, _ = cached.Username()
		pi.MemPct, _ = cached.MemoryPercent()
		if mi, err := cached.MemoryInfo(); err == nil && mi != nil {
			pi.RSS = mi.RSS
		}
		if st, err := cached.Status(); err == nil && len(st) > 0 {
			pi.Status = st[0]
		}
		out = append(out, pi)
	}
	for pid := range s.procs { // 清理已退出的进程缓存
		if !alive[pid] {
			delete(s.procs, pid)
		}
	}
	s.mu.Unlock()

	if sortBy == "mem" {
		sort.Slice(out, func(i, j int) bool { return out[i].RSS > out[j].RSS })
	} else {
		sort.Slice(out, func(i, j int) bool { return out[i].CPU > out[j].CPU })
	}
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

// ---------- systemd 服务控制 ----------

type ServiceManager struct {
	allowed []string
}

func (m *ServiceManager) isAllowed(name string) bool {
	for _, a := range m.allowed {
		if a == name {
			return true
		}
	}
	return false
}

func (m *ServiceManager) Status(ctx context.Context, name string) ServiceInfo {
	si := ServiceInfo{Name: name, Active: "unknown"}
	cmd := exec.CommandContext(ctx, "systemctl", "show", name, "-p",
		"ActiveState,SubState,Description,UnitFileState,ActiveEnterTimestampMonotonic,InactiveEnterTimestampMonotonic", "--no-pager")
	out, err := cmd.Output()
	if err != nil {
		return si
	}
	var activeMono, inactiveMono uint64
	for _, line := range strings.Split(string(out), "\n") {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch k {
		case "ActiveState":
			si.Active = v
		case "SubState":
			si.Sub = v
		case "Description":
			si.Description = v
		case "UnitFileState":
			si.Enabled = v
		case "ActiveEnterTimestampMonotonic":
			activeMono, _ = strconv.ParseUint(v, 10, 64)
		case "InactiveEnterTimestampMonotonic":
			inactiveMono, _ = strconv.ParseUint(v, 10, 64)
		}
	}
	// 单调时间戳是自开机起的微秒数，用它换算出处于当前状态的时长
	mono := activeMono
	if si.Active != "active" {
		mono = inactiveMono
	}
	if mono > 0 {
		if up, err := host.Uptime(); err == nil && up*1e6 > mono {
			si.Since = up - mono/1e6
		}
	}
	return si
}

func (m *ServiceManager) List(ctx context.Context) []ServiceInfo {
	out := make([]ServiceInfo, 0, len(m.allowed))
	for _, n := range m.allowed {
		out = append(out, m.Status(ctx, n))
	}
	return out
}

func (m *ServiceManager) Control(ctx context.Context, name, action string) error {
	if !m.isAllowed(name) {
		return fmt.Errorf("服务 %q 不在允许列表中", name)
	}
	switch action {
	case "start", "stop", "restart", "enable", "disable":
	default:
		return fmt.Errorf("不支持的操作 %q", action)
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "systemctl", action, name).CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl %s %s: %s", action, name, strings.TrimSpace(string(out)))
	}
	return nil
}

// ---------- HTTP ----------

type Server struct {
	sampler *Sampler
	svc     *ServiceManager
	token   string
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.token == "" {
			next.ServeHTTP(w, r)
			return
		}
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) != 1 {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) routes() http.Handler {
	api := http.NewServeMux()
	api.HandleFunc("GET /api/overview", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, s.sampler.Overview())
	})
	api.HandleFunc("GET /api/processes", func(w http.ResponseWriter, r *http.Request) {
		limit := 40
		if r.URL.Query().Get("limit") == "all" {
			limit = 0
		}
		writeJSON(w, 200, s.sampler.Processes(r.URL.Query().Get("sort"), limit))
	})
	api.HandleFunc("GET /api/services", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, s.svc.List(r.Context()))
	})
	api.HandleFunc("POST /api/services/{name}/{action}", func(w http.ResponseWriter, r *http.Request) {
		name, action := r.PathValue("name"), r.PathValue("action")
		if err := s.svc.Control(r.Context(), name, action); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		log.Printf("service %s %s by %s", action, name, r.RemoteAddr)
		writeJSON(w, 200, s.svc.Status(r.Context(), name))
	})
	api.HandleFunc("GET /api/ping", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]bool{"ok": true})
	})

	sub, _ := fs.Sub(webFS, "web")
	mux := http.NewServeMux()
	mux.Handle("/api/", s.auth(api))
	mux.Handle("/", http.FileServerFS(sub))
	return mux
}

// ---------- 配置 ----------

// Config 是 YAML 配置文件的结构，字段与命令行参数一一对应；命令行显式给出的参数优先级更高。
type Config struct {
	Addr     string        `yaml:"addr"`
	Token    string        `yaml:"token"`
	Services stringList    `yaml:"services"`
	Interval time.Duration `yaml:"interval"`
}

// stringList 同时接受 YAML 列表（- nginx）和逗号分隔的字符串（"nginx,docker"）
type stringList []string

func (l *stringList) UnmarshalYAML(n *yaml.Node) error {
	var one string
	if err := n.Decode(&one); err == nil {
		*l = splitList(one)
		return nil
	}
	var many []string
	if err := n.Decode(&many); err != nil {
		return fmt.Errorf("services 需要是字符串或列表: %w", err)
	}
	*l = splitList(strings.Join(many, ","))
	return nil
}

func splitList(s string) []string {
	var out []string
	for _, x := range strings.Split(s, ",") {
		if x = strings.TrimSpace(x); x != "" {
			out = append(out, x)
		}
	}
	return out
}

const defaultConfigFile = "servmon.yaml"

func loadConfig(path string) (Config, error) {
	var c Config
	data, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	if err := yaml.Unmarshal(data, &c); err != nil {
		return c, fmt.Errorf("解析 %s: %w", path, err)
	}
	return c, nil
}

func main() {
	cfgPath := flag.String("config", "", "YAML 配置文件路径（不指定时若当前目录有 servmon.yaml 则自动加载）")
	addr := flag.String("addr", ":8080", "监听地址")
	token := flag.String("token", "", "访问令牌（为空则不鉴权，仅建议在内网使用）")
	services := flag.String("services", "", "允许控制的 systemd 服务，逗号分隔，如 nginx,docker,sshd")
	interval := flag.Duration("interval", 2*time.Second, "采样间隔")
	flag.Parse()

	// 配置文件：显式 -config 必须存在；否则当前目录的 servmon.yaml 有则用、无则忽略
	path, explicit := *cfgPath, *cfgPath != ""
	if !explicit {
		if _, err := os.Stat(defaultConfigFile); err == nil {
			path = defaultConfigFile
		}
	}
	set := map[string]bool{}
	flag.Visit(func(f *flag.Flag) { set[f.Name] = true })
	allowed := splitList(*services)
	if path != "" {
		cfg, err := loadConfig(path)
		if err != nil {
			log.Fatalf("读取配置文件失败: %v", err)
		}
		log.Printf("已加载配置文件 %s", path)
		if !set["addr"] && cfg.Addr != "" {
			*addr = cfg.Addr
		}
		if !set["token"] && cfg.Token != "" {
			*token = cfg.Token
		}
		if !set["services"] && len(cfg.Services) > 0 {
			allowed = cfg.Services
		}
		if !set["interval"] && cfg.Interval > 0 {
			*interval = cfg.Interval
		}
	}
	if *interval < 200*time.Millisecond {
		log.Fatalf("采样间隔 %v 太短，至少 200ms", *interval)
	}

	sampler := NewSampler(*interval)
	go sampler.Run(context.Background())

	srv := &Server{sampler: sampler, svc: &ServiceManager{allowed: allowed}, token: *token}
	log.Printf("servmon 启动: http://%s  服务控制: %v  鉴权: %v  采样间隔: %v", *addr, allowed, *token != "", *interval)
	log.Fatal(http.ListenAndServe(*addr, srv.routes()))
}
