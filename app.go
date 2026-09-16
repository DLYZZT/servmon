package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

func main() {
	cfg := defaultConfig()
	path := flag.String("config", "", "YAML 配置路径")
	flag.StringVar(&cfg.Addr, "addr", cfg.Addr, "监听地址")
	flag.StringVar(&cfg.Token, "token", "", "管理令牌")
	flag.StringVar(&cfg.ViewToken, "view-token", "", "只读令牌")
	flag.StringVar(&cfg.DataDir, "data-dir", cfg.DataDir, "数据目录")
	flag.DurationVar(&cfg.Interval, "interval", cfg.Interval, "采样间隔")
	flag.DurationVar(&cfg.ProcInterval, "proc-interval", cfg.ProcInterval, "进程采样间隔")
	services := flag.String("services", "", "服务允许列表")
	flag.Parse()
	cli := cfg
	if *path == "" {
		if _, e := os.Stat("servmon.yaml"); e == nil {
			*path = "servmon.yaml"
		}
	}
	if *path != "" {
		c, e := loadConfig(*path)
		if e != nil {
			log.Fatal(e)
		}
		cfg = c
	}
	flag.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "addr":
			cfg.Addr = cli.Addr
		case "token":
			cfg.Token = cli.Token
		case "view-token":
			cfg.ViewToken = cli.ViewToken
		case "data-dir":
			cfg.DataDir = cli.DataDir
		case "interval":
			cfg.Interval = cli.Interval
		case "proc-interval":
			cfg.ProcInterval = cli.ProcInterval
		case "services":
			cfg.Services = splitList(*services)
		}
	})
	if e := cfg.validate(); e != nil {
		log.Fatal(e)
	}
	if cfg.DataDir != "" {
		e := os.MkdirAll(cfg.DataDir, 0700)
		if e == nil {
			var f *os.File
			f, e = os.CreateTemp(cfg.DataDir, ".write-test-*")
			if e == nil {
				f.Close()
				os.Remove(f.Name())
			}
		}
		if e != nil {
			log.Printf("数据目录不可写，回退内存模式: %v", e)
			cfg.DataDir = ""
		}
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	history := NewHistory(cfg.DataDir)
	notifier := NewNotifier(cfg.Notify, cfg.DataDir)
	s := &Server{sampler: NewSampler(cfg.Interval), svc: &ServiceManager{allowed: cfg.Services}, security: newSecurity(cfg), history: history, alerter: NewAlerter(cfg.Alerts, notifier.Enqueue), hub: NewHub(), docker: NewDocker("/var/run/docker.sock")}
	s.sampler.hook = func(o Overview) {
		history.Add("", o.Current)
		for _, n := range o.Interfaces {
			v := o.Current
			v.RxBps = n.Rx
			v.TxBps = n.Tx
			history.Add(n.Name, v)
		}
		s.alerter.Evaluate(o, s.serviceSnapshot(), time.Now())
		s.hub.Publish("overview", o)
		s.hub.Publish("alerts", s.alerter.Snapshot())
	}
	var wg sync.WaitGroup
	run := func(fn func()) { wg.Add(1); go func() { defer wg.Done(); fn() }() }
	run(func() { notifier.Run(ctx) })
	run(func() { s.sampler.Run(ctx) })
	run(func() {
		s.sampler.RunProcesses(ctx, cfg.ProcInterval, func() { s.hub.Publish("processes", s.sampler.Processes("cpu", 0)) })
	})
	run(func() { s.background(ctx) })
	run(func() { s.backgroundDocker(ctx) })
	srv := &http.Server{Addr: cfg.Addr, Handler: s.routes(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	run(func() {
		<-ctx.Done()
		c, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		srv.Shutdown(c)
		srv.Close()
	})
	log.Printf("servmon http://%s，采样 %s，进程采样 %s，持久化 %v", cfg.Addr, cfg.Interval, cfg.ProcInterval, cfg.DataDir != "")
	if e := srv.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		log.Printf("HTTP: %v", e)
		cancel()
	}
	cancel()
	wg.Wait()
	history.Flush()
	notifier.Flush()
}
