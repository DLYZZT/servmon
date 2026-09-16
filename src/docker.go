package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type ContainerInfo struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	Image          string  `json:"image"`
	State          string  `json:"state"`
	CPU            float64 `json:"cpu"`
	Memory         uint64  `json:"memory"`
	StatsAvailable bool    `json:"statsAvailable"`
}
type DockerSnapshot struct {
	Available  bool            `json:"available"`
	Containers []ContainerInfo `json:"containers"`
}
type DockerClient struct {
	client *http.Client
	mu     sync.RWMutex
	cached DockerSnapshot
}

func NewDocker(socket string) *DockerClient {
	return &DockerClient{client: &http.Client{Timeout: 8 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}}}
}
func (d *DockerClient) request(ctx context.Context, method, path string, out any) error {
	r, e := http.NewRequestWithContext(ctx, method, "http://docker"+path, nil)
	if e != nil {
		return e
	}
	resp, e := d.client.Do(r)
	if e != nil {
		return e
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("Docker HTTP %d", resp.StatusCode)
	}
	if out != nil {
		return json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out)
	}
	return nil
}
func (d *DockerClient) Collect(ctx context.Context) {
	out := DockerSnapshot{Containers: []ContainerInfo{}}
	var rows []struct {
		ID           string `json:"Id"`
		Names        []string
		Image, State string
	}
	if d.request(ctx, "GET", "/containers/json?all=true", &rows) == nil {
		out.Available = true
		for _, r := range rows {
			name := r.ID
			if len(r.Names) > 0 {
				name = strings.TrimPrefix(r.Names[0], "/")
			}
			v := ContainerInfo{ID: r.ID, Name: name, Image: r.Image, State: r.State}
			if r.State == "running" {
				var st struct {
					CPU struct {
						Usage struct {
							Total uint64 `json:"total_usage"`
						} `json:"cpu_usage"`
						System uint64 `json:"system_cpu_usage"`
						Online uint64 `json:"online_cpus"`
					} `json:"cpu_stats"`
					Pre struct {
						Usage struct {
							Total uint64 `json:"total_usage"`
						} `json:"cpu_usage"`
						System uint64 `json:"system_cpu_usage"`
					} `json:"precpu_stats"`
					Memory struct {
						Usage uint64            `json:"usage"`
						Stats map[string]uint64 `json:"stats"`
					} `json:"memory_stats"`
				}
				if d.request(ctx, "GET", "/containers/"+url.PathEscape(r.ID)+"/stats?stream=false&one-shot=true", &st) == nil {
					v.StatsAvailable = true
					v.Memory = st.Memory.Usage
					inactive := st.Memory.Stats["inactive_file"]
					if x := st.Memory.Stats["total_inactive_file"]; x > 0 {
						inactive = x
					}
					if inactive < v.Memory {
						v.Memory -= inactive
					}
					if st.CPU.System > st.Pre.System && st.CPU.Usage.Total >= st.Pre.Usage.Total {
						v.CPU = float64(st.CPU.Usage.Total-st.Pre.Usage.Total) / float64(st.CPU.System-st.Pre.System) * float64(st.CPU.Online) * 100
					}
				}
			}
			out.Containers = append(out.Containers, v)
		}
	}
	d.mu.Lock()
	d.cached = out
	d.mu.Unlock()
}
func (d *DockerClient) Snapshot() DockerSnapshot { d.mu.RLock(); defer d.mu.RUnlock(); return d.cached }
func (d *DockerClient) Control(ctx context.Context, id, action string) error {
	if action != "start" && action != "stop" && action != "restart" {
		return codedError("unsupported_container_action", "unsupported container action")
	}
	known := false
	for _, c := range d.Snapshot().Containers {
		if c.ID == id {
			known = true
		}
	}
	if !known {
		return codedError("unknown_container", "unknown container")
	}
	if err := d.request(ctx, "POST", "/containers/"+url.PathEscape(id)+"/"+action+"?t=5", nil); err != nil {
		return codedError("container_control_failed", err.Error())
	}
	return nil
}
