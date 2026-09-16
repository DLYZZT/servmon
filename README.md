# servmon

单文件个人服务器监控：Go + 内嵌网页，无前端框架、外部资源或数据库依赖。构建后只需拷贝一个二进制。

- CPU、每核占用 / 热力格、内存、磁盘用量与读写速率、多网卡和 Docker 容器。
- 告警持续时间与冷却状态机，Webhook / Telegram 触发及恢复通知；失败通知独立排队并重试。
- 3 分钟实时历史、1 分钟 × 24 小时、10 分钟 × 30 天的二进制历史，支持重启恢复、时间刻度及悬停数值。
- SSE 实时更新，断线重连和轮询兜底；进程默认每 5 秒采集，接口只读取缓存。
- HttpOnly 会话、管理 / 只读角色、登录限速、同源写入保护与操作审计。
- 进程搜索 / 分页 / 详情 / 结束，systemd 控制与日志抽屉，Docker start / stop / restart。
- 深浅主题、中英文、键盘快捷键、同组面板拖动排序、PWA 和离线提示。

## 构建与测试

```bash
go build -ldflags="-s -w" -o servmon .
go test -race ./...
go vet ./...
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o servmon-linux .
```

## 运行

```bash
cp servmon.example.yaml servmon.yaml
# 修改管理令牌、服务允许列表、告警和通知配置后启动
./servmon -config servmon.yaml

# 不使用配置文件
./servmon -addr 127.0.0.1:8080 -token your-admin-token \
  -view-token your-view-token -data-dir ./data -services nginx,sshd
```

| 参数 | YAML 字段 | 默认值 |
|---|---|---|
| `-config` | — | 自动读取当前目录 `servmon.yaml` |
| `-addr` | `addr` | `:8080` |
| `-token` | `token` | 空，无鉴权 |
| `-view-token` | `view_token` | 空，禁用只读令牌 |
| `-services` | `services` | 空；可用逗号字符串或 YAML 列表 |
| `-interval` | `interval` | `2s`，至少 `200ms` |
| `-proc-interval` | `proc_interval` | `5s`，至少 `1s` |
| `-data-dir` | `data_dir` | `/var/lib/servmon`；空值显式禁用落盘 |

CLI 显式给出的值优先，包含空字符串。完整配置见 [servmon.example.yaml](servmon.example.yaml)。告警默认禁用；示例文件启用常用阈值。修改配置后重启生效。

## 历史与通知

历史使用固定 48 字节记录，包含时间、CPU、内存、网络收发、负载、磁盘最高使用率、CPU 温度、磁盘读写速率。分钟和十分钟窗口取均值，磁盘使用率取最大值。每个网卡各保留两组历史，总量约 276 KB / 接口；聚合历史另占一组。每个完成窗口以临时文件 + fsync + rename 原子替换有限长度的环形快照；正常退出保存未满窗口，突然终止最多丢当前尚未完成的窗口。3 分钟历史只放内存。目录不可写、文件损坏会记日志，采样仍继续。

告警支持 CPU、内存、任一挂载点、1 分钟负载和服务 failed。条件持续 `sustain` 后触发，继续异常每隔 `cooldown` 提醒，恢复通知含持续时长。未知服务状态不会被当成恢复。告警历史最近 50 条保存在内存。

Webhook 发送 JSON：`host`、`rule`、`state` (`firing` / `resolved`)、`value`、`threshold`、`since`、`message`、`at`，并设置 `X-Servmon-Event`。Telegram 使用 Bot API `sendMessage`。首次失败后重试 3 次，此后每 30 秒继续尝试；同渠道保证事件顺序，一个渠道失败不阻塞其它渠道。队列异步持久化到 `notifications.json`，进程正常重启可以继续发送。无可写数据目录时仅在内存保留；投递语义为至少一次，接收方应允许重复事件。通知的磁盘与网络操作不在采样 goroutine 中执行。

## 安全与部署

网页使用 `/api/login` 换取 24 小时会话 Cookie（HttpOnly、SameSite=Strict）；直接 HTTPS 请求自动加 Secure。反向代理终止 TLS 时，请由代理给 `servmon_session` 加 Secure，并保持 Host、禁用 SSE 缓冲。服务器不信任任意客户端提供的 X-Forwarded-For / X-Forwarded-Proto，登录限速按直接连接 IP 执行；反代后应同时在代理层配置客户端限速。

会话只保存在服务器内存，重启后需重新登录。前端移除旧版本 localStorage 令牌，不再保存令牌；退出会撤销会话并删除当前标签页离线快照。PWA 仅缓存静态页面，最后一次 overview 放在当前标签页 sessionStorage；不缓存认证 API 或完整进程命令行。

5 次错误鉴权后封禁该来源 1 分钟，再次连续失败指数退避，最多 1 小时。只读角色可以读所有监控数据和日志，写操作返回 403。浏览器只显示该角色允许的操作。

服务名必须在允许列表；服务控制需要 systemd 和相应权限。结束进程支持 TERM / KILL，拒绝 PID ≤ 1 和 servmon 自身，需提交详情返回的创建时间避免 PID 重用误杀，页面要求确认。操作在执行前后写入 `data_dir/audit.log`；审计不可写时返回 503 并拒绝执行。应用令牌在命令行详情中脱敏；其它进程的完整命令行属于监控数据，按需限制只读令牌的分享。

Docker 自动检测 `/var/run/docker.sock`，不可用时隐藏面板；不引入 Docker SDK。容器资源统计参考 [Docker Engine API](https://docs.docker.com/reference/api/engine/version/v1.46/)。仅对列表中的容器开放控制。CPU 温度只接受已识别 CPU 传感器，无法读取时显示 `—`；磁盘 IO 的分区映射尽量匹配父设备，复杂 LVM / RAID 和权限不足时可能不可用。

`/etc/systemd/system/servmon.service`：

```ini
[Unit]
Description=servmon
After=network.target

[Service]
ExecStart=/usr/local/bin/servmon -config /etc/servmon.yaml
Restart=always
StateDirectory=servmon

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now servmon
```

## API

脚本可继续使用 `Authorization: Bearer <token>`，只读令牌同样适用。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | JSON `{"token":"..."}`，建立会话 |
| POST | `/api/logout` | 注销会话 |
| GET | `/api/ping` | `role`、鉴权及持久化状态 |
| GET | `/api/overview` | 缓存的主机、CPU / 内存 / 磁盘 / 多网卡及实时历史 |
| GET | `/api/history?range=3m\|1h\|24h\|7d\|30d&iface=en0` | 历史数组；省略 iface 获取聚合数据 |
| GET | `/api/alerts` | 活跃告警和最近 50 条历史 |
| GET | `/api/stream` | SSE：overview / processes / services / alerts / containers / heartbeat |
| GET | `/api/processes?sort=cpu\|mem&limit=all` | 默认前 40 个，all 返回全部缓存 |
| GET | `/api/processes/{pid}` | 命令行、目录、创建时间、线程、打开文件数量及不可用字段 |
| POST | `/api/processes/{pid}/kill?signal=TERM\|KILL&created=...` | 管理角色；created 为详情里的毫秒时间戳 |
| GET | `/api/services` | 每 5 秒更新的允许列表状态 |
| GET | `/api/services/{name}/logs?n=200` | 最近 1–1000 行 journalctl 日志 |
| POST | `/api/services/{name}/{start\|stop\|restart\|enable\|disable}` | 管理角色 |
| GET | `/api/containers` | Docker 可用状态与容器缓存 |
| POST | `/api/containers/{id}/{start\|stop\|restart}` | 管理角色 |

## 界面

时间范围同时影响 CPU 和网络历史图；网卡选择只改变网络数据。默认选择累计流量最大的接口，选择“总流量”可查看聚合。进程名称最多 64 字符，详情展示完整命令行。进程 CPU 百分比允许超过 100%（多个 CPU 核）。

`/` 聚焦进程搜索，`p` 暂停 / 恢复，`t` 切换主题。输入或打开抽屉时不触发快捷键。卡片标题前的拖动手柄可在同组重排，也可聚焦后按 Alt + ← / →；顺序和主题保存在 localStorage。语言按浏览器偏好初始化，右上角可切换中英文。

PWA 安装要求 HTTPS 或 localhost。离线时保留最后一次数据并明确显示离线；服务器恢复自动重连。`?theme=dark|light|auto` 仍然可用。

## 验证记录

见 [TESTING.md](TESTING.md)，包含自动化测试、性能测量、Computer Use 操作结果及平台验证限制。

性能比较工具：`python3 scripts/benchmark.py --baseline /path/to/old --candidate /path/to/new`，默认运行 600 秒并输出累计 CPU 时间及比值。
