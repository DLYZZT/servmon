package main

import (
	"fmt"
	"gopkg.in/yaml.v3"
	"math"
	"net/url"
	"os"
	"strings"
	"time"
)

type Config struct {
	Addr         string        `yaml:"addr"`
	Token        string        `yaml:"token"`
	ViewToken    string        `yaml:"view_token"`
	Services     stringList    `yaml:"services"`
	Interval     time.Duration `yaml:"interval"`
	ProcInterval time.Duration `yaml:"proc_interval"`
	DataDir      string        `yaml:"data_dir"`
	Alerts       AlertConfig   `yaml:"alerts"`
	Notify       NotifyConfig  `yaml:"notify"`
}
type AlertConfig struct {
	CPU           float64       `yaml:"cpu"`
	Mem           float64       `yaml:"mem"`
	Disk          float64       `yaml:"disk"`
	Load1         float64       `yaml:"load1"`
	ServiceFailed bool          `yaml:"service_failed"`
	Sustain       time.Duration `yaml:"sustain"`
	Cooldown      time.Duration `yaml:"cooldown"`
}
type NotifyConfig struct {
	Webhook  stringList `yaml:"webhook"`
	Telegram struct {
		Token  string `yaml:"token"`
		ChatID string `yaml:"chat_id"`
	} `yaml:"telegram"`
}
type stringList []string

func (l *stringList) UnmarshalYAML(n *yaml.Node) error {
	var one string
	if n.Decode(&one) == nil {
		*l = splitList(one)
		return nil
	}
	var many []string
	if err := n.Decode(&many); err != nil {
		return err
	}
	*l = splitList(strings.Join(many, ","))
	return nil
}
func splitList(s string) []string {
	out := []string{}
	for _, x := range strings.Split(s, ",") {
		if x = strings.TrimSpace(x); x != "" {
			out = append(out, x)
		}
	}
	return out
}
func defaultConfig() Config {
	return Config{Addr: ":8080", Interval: 2 * time.Second, ProcInterval: 5 * time.Second, DataDir: "/var/lib/servmon", Alerts: AlertConfig{Sustain: 30 * time.Second, Cooldown: 10 * time.Minute}}
}
func loadConfig(path string) (Config, error) {
	c := defaultConfig()
	data, e := os.ReadFile(path)
	if e != nil {
		return c, e
	}
	e = yaml.Unmarshal(data, &c)
	return c, e
}
func (c Config) validate() error {
	if c.Interval < 200*time.Millisecond || c.ProcInterval < time.Second {
		return fmt.Errorf("interval 至少 200ms，proc_interval 至少 1s")
	}
	if c.ViewToken != "" && (c.Token == "" || c.Token == c.ViewToken) {
		return fmt.Errorf("view_token 需要独立且非空的管理 token")
	}
	if c.Alerts.Sustain < 0 || c.Alerts.Cooldown < time.Second {
		return fmt.Errorf("sustain 不能为负，cooldown 至少 1s")
	}
	for _, v := range []float64{c.Alerts.CPU, c.Alerts.Mem, c.Alerts.Disk} {
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || v > 100 {
			return fmt.Errorf("百分比告警阈值应为 0–100")
		}
	}
	if math.IsNaN(c.Alerts.Load1) || math.IsInf(c.Alerts.Load1, 0) || c.Alerts.Load1 < 0 {
		return fmt.Errorf("load1 不能为负")
	}
	for _, endpoint := range c.Notify.Webhook {
		u, e := url.Parse(endpoint)
		if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return fmt.Errorf("webhook 必须为 HTTP(S) URL")
		}
	}
	if (c.Notify.Telegram.Token == "") != (c.Notify.Telegram.ChatID == "") {
		return fmt.Errorf("Telegram token 和 chat_id 需要同时配置")
	}
	for _, name := range c.Services {
		if !validService(name) {
			return fmt.Errorf("无效服务名 %q", name)
		}
	}
	return nil
}
func validService(s string) bool {
	if s == "" || strings.HasPrefix(s, "-") {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("._@:-", r)) {
			return false
		}
	}
	return true
}
