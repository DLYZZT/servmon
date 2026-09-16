// servmon — 单文件个人服务器监控面板
//
// 构建（项目根目录）: make build
// 运行: sudo ./bin/servmon -addr :8080 -token 你的密码 -services nginx,docker,sshd
package main

import (
	"context"
	"embed"
	"fmt"
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
)

//go:embed web
var webFS embed.FS

const historyLen = 90 // 保留的采样点数（2s 间隔 ≈ 3 分钟）

// 不展示的文件系统类型（伪文件系统 / 镜像挂载）
var skipFS = map[string]bool{"squashfs": true, "devfs": true, "devtmpfs": true, "tmpfs": true, "overlay": true, "autofs": true, "fuse.snapfuse": true}

// ---------- 数据结构 ----------

type Sample struct {
	T        int64   `json:"t"`   // unix 秒
	CPU      float64 `json:"cpu"` // 总 CPU %
	Mem      float64 `json:"mem"` // 内存 %
	RxBps    float64 `json:"rx"`  // 下行 bytes/s
	TxBps    float64 `json:"tx"`  // 上行 bytes/s
	Load1    float64 `json:"load1"`
	Disk     float64 `json:"disk"`
	Temp     float64 `json:"temp"`
	ReadBps  float64 `json:"read"`
	WriteBps float64 `json:"write"`
}

type DiskInfo struct {
	Mount    string  `json:"mount"`
	FS       string  `json:"fs"`
	Total    uint64  `json:"total"`
	Used     uint64  `json:"used"`
	Percent  float64 `json:"percent"`
	Device   string  `json:"device"`
	ReadBps  float64 `json:"read"`
	WriteBps float64 `json:"write"`
}

type Overview struct {
	Interfaces []NetInfo  `json:"interfaces"`
	Host       string     `json:"host"`
	OS         string     `json:"os"`
	Kernel     string     `json:"kernel"`
	Uptime     uint64     `json:"uptime"`
	Cores      int        `json:"cores"`    // 逻辑核
	Physical   int        `json:"physical"` // 物理核（取不到时为 0）
	CPUModel   string     `json:"cpuModel"`
	CPUMhz     float64    `json:"cpuMhz"`
	Temp       float64    `json:"temp"` // CPU 温度 °C，取不到时为 0
	PerCore    []float64  `json:"perCore"`
	Load       [3]float64 `json:"load"`
	MemTotal   uint64     `json:"memTotal"`
	MemUsed    uint64     `json:"memUsed"`
	MemCached  uint64     `json:"memCached"`
	SwapTotal  uint64     `json:"swapTotal"`
	SwapUsed   uint64     `json:"swapUsed"`
	Disks      []DiskInfo `json:"disks"`
	NetIface   string     `json:"netIface"`
	NetRxTot   uint64     `json:"netRxTotal"`
	NetTxTot   uint64     `json:"netTxTotal"`
	ProcCount  int        `json:"procCount"`
	Interval   float64    `json:"interval"` // 采样间隔（秒）
	Current    Sample     `json:"current"`
	History    []Sample   `json:"history"`
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
	mu         sync.RWMutex
	history    []Sample
	perCore    []float64
	lastNet    net.IOCountersStat
	lastT      time.Time
	iface      string
	cpuModel   string
	cpuMhz     float64
	physical   int
	temp       float64
	procCount  int
	procs      map[int32]*process.Process
	interval   time.Duration
	cached     Overview
	procCache  []ProcInfo
	lastIfaces map[string]net.IOCountersStat
	lastIO     map[string]disk.IOCountersStat
	hook       func(Overview)
	ioTime     time.Time
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
		if (n.Name == "lo" || n.Name == "lo0") || strings.HasPrefix(n.Name, "veth") || strings.HasPrefix(n.Name, "docker") ||
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
	return 0
}

func NewSampler(interval time.Duration) *Sampler {
	return &Sampler{interval: interval, procs: map[int32]*process.Process{}, lastIfaces: map[string]net.IOCountersStat{}, lastIO: map[string]disk.IOCountersStat{}}
}

func (s *Sampler) Run(ctx context.Context) {
	// 预热：让 cpu.Percent 有一个基准点
	_, _ = cpu.Percent(0, false)
	_, _ = cpu.Percent(0, true)
	if n, iface, ok := netCounters(); ok {
		s.mu.Lock()
		s.lastNet, s.lastT, s.iface = n, time.Now(), iface
		s.mu.Unlock()
	}
	if info, err := cpu.Info(); err == nil && len(info) > 0 {
		s.mu.Lock()
		s.cpuModel = strings.TrimSpace(info[0].ModelName)
		s.mu.Unlock()
	}
	if n, err := cpu.Counts(false); err == nil {
		s.mu.Lock()
		s.physical = n
		s.mu.Unlock()
	}
	s.collect()
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
	for len(s.history) > 0 && s.history[0].T < smp.T-180 {
		s.history = s.history[1:]
	}
	s.mu.Unlock()
	o := s.buildOverview()
	s.collectIO(&o, now)
	for _, d := range o.Disks {
		if d.Percent > o.Current.Disk {
			o.Current.Disk = d.Percent
		}
	}
	o.Current.Temp = o.Temp
	s.mu.Lock()
	if len(s.history) > 0 {
		s.history[len(s.history)-1] = o.Current
	}
	o.History = append([]Sample{}, s.history...)
	s.cached = o
	s.mu.Unlock()
	if s.hook != nil {
		s.hook(o)
	}
}

func (s *Sampler) Overview() Overview { s.mu.RLock(); defer s.mu.RUnlock(); return s.cached }

func (s *Sampler) buildOverview() Overview {
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
			o.Disks = append(o.Disks, DiskInfo{Mount: p.Mountpoint, FS: p.Fstype, Total: u.Total, Used: u.Used, Percent: u.UsedPercent, Device: p.Device})
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
func (s *Sampler) collectProcesses() {
	list, err := process.Processes()
	if err != nil {
		return
	}
	vm, _ := mem.VirtualMemory()
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
		if r := []rune(pi.Name); len(r) > 64 {
			pi.Name = string(r[:64])
		}
		pi.User, _ = cached.Username()
		if mi, err := cached.MemoryInfo(); err == nil && mi != nil {
			pi.RSS = mi.RSS
			if vm != nil && vm.Total > 0 {
				pi.MemPct = float32(float64(pi.RSS) / float64(vm.Total) * 100)
			}
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
	s.mu.Lock()
	s.procCache = out
	s.mu.Unlock()
}

func (s *Sampler) Processes(sortBy string, limit int) []ProcInfo {
	s.mu.RLock()
	out := append([]ProcInfo{}, s.procCache...)
	s.mu.RUnlock()
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
