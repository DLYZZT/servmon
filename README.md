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
make               # 本机二进制：bin/servmon
make check         # Go 竞态测试、go vet、JavaScript 语法与功能测试
make linux         # bin/servmon-linux-amd64 和 bin/servmon-linux-arm64
make help          # 查看全部目标
```

在项目根目录执行。构建只需要 Go；`make check` 的前端检查还需要 Node.js（使用内置测试工具，无需安装 npm 依赖），`make test` 的竞态检测需要可用的 CGO / C 编译器。服务器运行二进制不需要这些开发工具。`make test-web` 可单独运行国际化和布局测试。

`make run ARGS='-addr 127.0.0.1:8080 -data-dir ./data'` 可直接构建并启动；`make fmt` 格式化 Go 文件，`make clean` 仅删除 `bin/` 中的三个构建产物。可通过 `GO`、`GOFMT`、`NODE` 和 `LDFLAGS` 覆盖工具或构建选项。

不使用 Make 时：`go build -trimpath -ldflags="-s -w" -o bin/servmon ./src`。Go 模块位于根目录，入口包位于 `./src`，测试仍可运行 `go test -race ./...`。

## 目录结构

```text
servmon/
├── src/                   # Go 源码与测试，同属 main 包
│   ├── app.go             # 启动入口和命令行参数
│   ├── main.go            # 采样器、数据结构和网页嵌入
│   ├── *_test.go          # 后端测试
│   └── web/               # 内嵌 HTML / CSS / JavaScript / PWA 资源
├── scripts/               # 本地性能对比等开发脚本，不提交 Git
├── tests/                 # 国际化与布局的前端测试
├── test-results/          # 本地测试结果，不提交 Git
├── bin/                   # 构建产物，不提交 Git
├── Makefile               # 统一构建、测试与运行入口
├── install.sh             # Linux / systemd 安装与升级
├── go.mod / go.sum        # Go 模块和依赖锁定
├── servmon.example.yaml   # 配置示例
├── docs/                  # 本地优化计划与验收记录，不提交 Git
└── README.md              # 使用说明
```

网页放在 `src/web/`，与声明 `go:embed web` 的 Go 包相邻，构建后仍全部嵌入二进制。配置文件和数据目录仍按启动时的工作目录解析。

## 运行

```bash
cp servmon.example.yaml servmon.yaml
# 修改管理令牌、服务允许列表、告警和通知配置后启动
./bin/servmon -config servmon.yaml

# 不使用配置文件
./bin/servmon -addr 127.0.0.1:8080 -token your-admin-token \
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

## Linux 安装

支持 amd64 / arm64，需要 Bash、常用 GNU 文件工具、root 权限和 systemd。在有 Go 的源码目录中：

```bash
sudo ./install.sh --build
```

也可以在开发机执行 `make linux`，将 `install.sh` 和对应二进制拷到服务器同一目录，服务器无需 Go：

```bash
sudo ./install.sh --binary ./servmon-linux-amd64
# arm64 服务器使用 ./servmon-linux-arm64
```

不指定 `--binary` / `--build` 时，脚本按顺序查找 `bin/servmon-linux-架构`、同目录的 `servmon-linux-架构`、`bin/servmon`、同目录的 `servmon`，找不到才尝试源码构建；不下载发布文件。显式 `--build` 可避免升级时误用旧构建产物。

脚本安装到 `/usr/local/bin/servmon`，配置在 `/etc/servmon.yaml`，systemd 单元在 `/etc/systemd/system/servmon.service`，默认数据目录是 `/var/lib/servmon`。首次安装自动生成不同的管理 / 只读令牌，配置权限为 `600`，默认监听 `127.0.0.1:8080`，服务允许列表为空。令牌只写入配置，不打印到安装日志；可用 `sudo cat /etc/servmon.yaml` 在服务器本机查看并调整配置。

```bash
# 首次生成配置时更改监听地址
sudo ./install.sh --binary ./servmon-linux-amd64 --addr :8080

# 首次使用准备好的配置；已有 /etc/servmon.yaml 时保持原样
sudo ./install.sh --binary ./servmon-linux-amd64 --config ./my-servmon.yaml

# 只安装文件，不启用、启动或重启服务；可用于 systemd 未运行的镜像
sudo ./install.sh --binary ./servmon-linux-amd64 --no-start
```

重复执行即升级：原子替换二进制和服务文件，保留已有配置、令牌与监控数据，然后启用开机自启并启动或重启服务。`--config` 和 `--addr` 不修改已有配置。服务以 root 运行以支持系统服务、进程和 Docker 管理；自定义 systemd 设置请放在 `servmon.service.d/` 的 drop-in 中。配置中的相对路径按 `/var/lib/servmon` 解析。

若替换后的服务启动失败，脚本返回非零状态，并尝试恢复旧二进制、服务文件及原运行状态；配置和数据保留以便排障。使用 `systemctl status servmon.service` 或 `journalctl -u servmon.service -f` 查看状态。`make check-install` 检查脚本语法，`make test-install` 在隔离 Docker 容器中测试安装和回滚，不在宿主机执行安装。

## 历史与通知

历史使用固定 48 字节记录，包含时间、CPU、内存、网络收发、负载、磁盘最高使用率、CPU 温度、磁盘读写速率。分钟和十分钟窗口取均值，磁盘使用率取最大值。每个网卡各保留两组历史，总量约 276 KB / 接口；聚合历史另占一组。每个完成窗口以临时文件 + fsync + rename 原子替换有限长度的环形快照；正常退出保存未满窗口，突然终止最多丢当前尚未完成的窗口。3 分钟历史只放内存。目录不可写、文件损坏会记日志，采样仍继续。

告警支持 CPU、内存、任一挂载点、1 分钟负载和服务 failed。条件持续 `sustain` 后触发，继续异常每隔 `cooldown` 提醒，恢复通知含持续时长。未知服务状态不会被当成恢复。告警历史最近 50 条保存在内存。

Webhook 发送 JSON：`host`、`rule`、`state` (`firing` / `resolved`)、`value`、`threshold`、`since`、`message`、`at`，并设置 `X-Servmon-Event`。Telegram 使用 Bot API `sendMessage`。首次失败后重试 3 次，此后每 30 秒继续尝试；同渠道保证事件顺序，一个渠道失败不阻塞其它渠道。队列异步持久化到 `notifications.json`，进程正常重启可以继续发送。无可写数据目录时仅在内存保留；投递语义为至少一次，接收方应允许重复事件。通知的磁盘与网络操作不在采样 goroutine 中执行。

## 安全与部署

网页使用 `/api/login` 换取 24 小时会话 Cookie（HttpOnly、SameSite=Strict）；直接 HTTPS 请求自动加 Secure。反向代理终止 TLS 时，请由代理给 `servmon_session` 加 Secure，并保持 Host、禁用 SSE 缓冲。服务器不信任任意客户端提供的 X-Forwarded-For / X-Forwarded-Proto，登录限速按直接连接 IP 执行；反代后应同时在代理层配置客户端限速。

会话只保存在服务器内存，重启后需重新登录。前端移除旧版本 localStorage 令牌，不再保存令牌；退出会撤销会话并删除当前标签页离线快照。PWA 仅缓存静态页面，最后一次 overview 放在当前标签页 sessionStorage；不缓存认证 API 或完整进程命令行。

5 次错误鉴权后封禁该来源 1 分钟，再次连续失败指数退避，最多 1 小时。只读角色可以读所有监控数据和日志，写操作返回 403。浏览器只显示该角色允许的操作。

服务名必须在允许列表；服务控制需要 systemd 和相应权限。结束进程支持 TERM / KILL，拒绝 PID ≤ 1 和 servmon 自身，需提交详情返回的创建时间避免 PID 重用误杀，页面要求确认。操作在执行前后写入 `data_dir/audit.log`；审计不可写时返回 503 并拒绝执行。应用令牌在命令行详情中脱敏；其它进程的完整命令行属于监控数据，按需限制只读令牌的分享。

Docker 自动检测 `/var/run/docker.sock`，不可用时在 Docker 标签页显示状态提示；不引入 Docker SDK。容器资源统计参考 [Docker Engine API](https://docs.docker.com/reference/api/engine/version/v1.46/)。仅对列表中的容器开放控制。CPU 温度只接受已识别 CPU 传感器，无法读取时显示 `—`；磁盘 IO 的分区映射尽量匹配父设备，复杂 LVM / RAID 和权限不足时可能不可用。

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

错误响应保留原有 `error` 文本，并增加稳定的 `code`（如 `read_only`、`logs_unavailable`、`protected_pid`）。网页按错误码显示当前语言的提示；原始错误仍保留在 API 响应和审计中，便于排障。

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

界面分为四个标签页：“基础信息”展示 CPU、内存、磁盘、网络和每核占用；“进程”提供全宽进程列表、搜索、分页与详情；“Docker”展示容器及操作；“系统服务”提供 systemd 状态、服务控制和日志。顶部的主机状态、告警、主题和刷新开关始终可用。

标签页共用一条 SSE 连接，切换保留搜索条件和分页，不重新登录。地址栏的 `#overview`、`#processes`、`#docker`、`#services` 可直接定位，刷新后仍停留在对应页面。标签聚焦时支持左右方向键以及 Home / End 切换。

时间范围同时影响 CPU 和网络历史图；网卡选择只改变网络数据。默认选择累计流量最大的接口，选择“总流量”可查看聚合。进程名称最多 64 字符，详情展示完整命令行。进程 CPU 百分比允许超过 100%（多个 CPU 核）。

`/` 打开进程面板所在的标签页并聚焦搜索，`p` 暂停 / 恢复，`t` 切换主题。输入或打开对话框时不触发快捷键。

默认浏览模式隐藏各面板的拖拽手柄和 `⋯` 菜单，也隐藏恢复默认按钮。点击顶部“编辑布局”后统一显示这些控件；点击“完成编辑”回到简洁的监控界面。修改即时保存，切换标签页时保持编辑状态，刷新页面后默认退出编辑模式，已保存的布局仍保留。

编辑模式下，九个面板均可通过标题前的手柄拖动，同组排序、跨组移动和跨标签页移动都支持。拖到标签按钮上即可放入该页；悬停标签会切页，继续拖动可选择具体位置。拖动时靠近屏幕边缘自动滚动，按 Esc 可取消。各面板的 `⋯` 按钮打开“移动到…”对话框，可直接选择目标组 / 页面及最前或最后位置；键盘聚焦手柄后按 Alt + 方向键可在当前组重排。进程、容器和服务面板始终占满一行，避免移入指标组后内容拥挤。

布局保存在 localStorage，刷新后恢复；旧版基础信息页的排序会迁移，损坏或重复的布局数据会自动修复。“恢复默认布局”在确认后恢复四个标签页的初始面板分布。空标签页会提示如何移入面板，历史范围控件跟随含 CPU 或网络曲线的页面显示。

语言按浏览器偏好初始化，登录页和顶部均可切换中英文，无需刷新；切换保留搜索、排序、分页、暂停状态和自定义布局。`src/web/i18n.js` 集中管理静态文案、动态模板、单复数、提示、无障碍标签及 API 错误文案。确认操作使用页内对话框，按钮也跟随语言。主机名、服务名、镜像名、命令行及原始日志保持原文。

PWA 安装要求 HTTPS 或 localhost。离线时保留最后一次数据并明确显示离线；服务器恢复自动重连。`?theme=dark|light|auto` 仍然可用。

## 验证记录

本地验收记录保存在 `docs/TESTING.md`，包含自动化测试、性能测量、Computer Use 操作结果及平台验证限制。该文件不提交 Git，克隆仓库后不会自带。

本地性能比较工具：`python3 scripts/benchmark.py --baseline /path/to/old --candidate /path/to/new`，默认运行 600 秒并输出累计 CPU 时间及比值。`scripts/` 与 `test-results/` 不提交 Git，克隆仓库后不会自带。
