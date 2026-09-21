# servmon

单文件个人服务器监控：Go + 内嵌网页，无前端框架、外部资源或数据库依赖。

- 实时查看 CPU、内存、磁盘、网络、进程、systemd 服务和 Docker 容器。
- 支持最长 30 天历史、阈值告警，以及 Webhook / Telegram 触发和恢复通知。
- 管理与只读角色分离，支持进程结束、服务和容器控制及操作审计。
- SSE 实时更新，支持中英文、深浅主题、自定义面板布局和 PWA。

## 快速安装

支持 Linux / macOS 的 x86_64（amd64）和 ARM64（arm64）。在线安装无需 Go，需要 Bash、curl 或 wget、SHA-256 工具和 root 权限；Linux 还需要 systemd。

一条命令安装或升级到最新正式版本：

```bash
curl -fsSL https://github.com/DLYZZT/servmon/releases/latest/download/install.sh | sudo bash
```

管道执行无需参数，脚本自动检测系统和架构，从 `DLYZZT/servmon` 下载最新二进制，并验证 `checksums.txt` 中的 SHA-256。

也可先保存脚本再安装，或指定版本：

```bash
curl -fsSL https://github.com/DLYZZT/servmon/releases/latest/download/install.sh -o install.sh
sudo bash install.sh --download
sudo bash install.sh --version v0.1
```

安装脚本默认使用 `DLYZZT/servmon`；也可用 `--repo` 或 `SERVMON_REPO` 指定其他仓库。Release 附带的脚本会自动带入发布仓库名。`--download` 强制在线安装，`--repo` / `--version` 隐含此选项；从本地文件执行且不指定来源时，依次尝试本地二进制、源码编译和在线下载。

在已安装 Go 1.22+ 的源码目录中也可执行：

```bash
sudo ./install.sh --build
```

Linux 上脚本安装二进制、生成管理 / 只读令牌，并启用开机自启。默认监听 `127.0.0.1:8080`，服务以 root 运行。

macOS 上仅安装 `/usr/local/bin/servmon`，不创建后台服务；请按下方「手动安装」准备 YAML 配置（设置令牌及可写的 `data_dir`），然后执行 `servmon -config ./servmon.yaml`。systemd 服务监控与控制仅适用于 Linux。

| 内容 | 路径 |
|---|---|
| 二进制 | `/usr/local/bin/servmon` |
| 配置与令牌 | `/etc/servmon.yaml`（权限 `600`） |
| systemd 单元 | `/etc/systemd/system/servmon.service` |
| 历史与审计数据 | `/var/lib/servmon` |

```bash
sudo cat /etc/servmon.yaml             # 查看令牌；编辑配置后重启服务
sudo systemctl restart servmon
sudo systemctl status servmon
sudo journalctl -u servmon -f
```

在服务器本机打开 `http://127.0.0.1:8080`；远程访问可使用 SSH 隧道或 HTTPS 反向代理。首次安装可用 `--addr HOST:PORT` 指定监听地址，或用 `--config PATH` 导入配置。

服务器没有 Go 时，在开发机运行 `make linux`，将 `install.sh` 和对应架构的二进制拷到服务器，再执行：

```bash
sudo ./install.sh --binary ./servmon-linux-amd64
# arm64 使用 ./servmon-linux-arm64
```

重复执行在线安装命令即可升级。Linux 上已有配置、令牌和数据会保留；启动失败时尝试回滚。离线安装使用 `--binary` 或 `--build`，更多选项见 `./install.sh --help`。

## 自动构建与发布

`.github/workflows/build.yml` 在分支推送、Pull Request 和手动触发时运行检查、安装测试，并生成以下四个二进制，打包为 Actions 的 `servmon-binaries` artifact：

| 平台 | 文件 |
|---|---|
| macOS Intel x86_64 | `servmon-darwin-amd64` |
| macOS Apple Silicon ARM64 | `servmon-darwin-arm64` |
| Linux x86_64 | `servmon-linux-amd64` |
| Linux ARM64 | `servmon-linux-arm64` |

推送 `v*` 标签（例如 `v1.0.0`）会在检查成功后自动创建 GitHub Release，并上传四个二进制、`checksums.txt`、带仓库名的 `install.sh` 和配置示例。包含 `-` 的标签（例如 `v1.0.0-rc.1`）标记为预发布，在线安装时需用 `--version` 指定。普通分支构建不会发布 Release；需要在仓库中启用 GitHub Actions。

## 手动安装

需要 Go 1.22+，在项目根目录构建并准备配置：

```bash
go build -trimpath -ldflags="-s -w" -o bin/servmon ./src
cp servmon.example.yaml servmon.yaml
chmod 600 servmon.yaml
```

编辑 `servmon.yaml`：设置 `addr: "127.0.0.1:8080"`、非空管理令牌 `token`、可选且不同的只读令牌 `view_token`，并将 `data_dir` 设为有写权限的目录（例如 `./data`）。按需调整服务允许列表、告警和通知，然后启动：

```bash
./bin/servmon -config servmon.yaml
```

打开 `http://127.0.0.1:8080` 并使用配置中的令牌登录。管理令牌为空时不启用鉴权。服务管理需要 systemd 和相应权限；Docker 管理需要访问 `/var/run/docker.sock`；写操作需要可写的数据目录来保存审计日志。

## 配置说明

手动运行使用 `servmon.yaml`，脚本安装使用 `/etc/servmon.yaml`。未指定 `-config` 时自动读取当前工作目录的 `servmon.yaml`；配置优先级为：程序默认值 → YAML → 显式命令行参数。

以下示例用于手动运行，使用前替换管理令牌，并按需设置服务和通知：

```yaml
addr: "127.0.0.1:8080"       # 监听地址；改为 :8080 可监听所有网卡
token: "replace-with-a-long-random-token" # 管理令牌；为空则不启用鉴权
view_token: ""               # 可选只读令牌，必须与管理令牌不同
services: [nginx, sshd]       # 允许监控、读取日志和控制的 systemd 服务
interval: 2s                 # 主机采样间隔，至少 200ms
proc_interval: 5s            # 进程采样间隔，至少 1s
data_dir: ./data             # 历史、通知队列和审计目录，需要写权限

alerts:
  cpu: 90                    # CPU 使用率阈值（%），0 关闭
  mem: 90                    # 内存使用率阈值（%），0 关闭
  disk: 90                   # 任一挂载点使用率阈值（%），0 关闭
  load1: 0                   # 1 分钟绝对负载阈值，0 关闭
  service_failed: true       # 服务处于 failed 状态时告警
  sustain: 30s               # 异常持续多久后触发，允许 0s
  cooldown: 10m              # 持续异常时重复提醒间隔，至少 1s

notify:
  webhook: []                # 接收告警的 HTTP(S) URL 列表
  telegram:
    token: ""                # Telegram Bot token
    chat_id: ""              # 目标聊天 ID，与 Bot token 同时填写
```

示例启用了常用告警；程序未配置时默认关闭告警，监听 `:8080`，数据目录为 `/var/lib/servmon`。`data_dir` 相对路径按工作目录解析，设为空字符串可禁用落盘，但控制操作也会因无法写入审计日志而被拒绝。Webhook 和 Telegram 可同时启用，未配置渠道时仍可在网页查看告警。

修改配置后需重启；脚本安装可执行 `sudo systemctl restart servmon`，升级时会保留已有配置。
## 目录结构

```text
servmon/
├── src/                   # Go 源码与后端测试
│   └── web/               # 内嵌网页资源
├── tests/                 # 前端与安装脚本测试
├── Makefile               # 构建、测试与开发命令
├── install.sh             # 在线 / 离线安装；Linux systemd、macOS 二进制
├── .github/workflows/     # 四平台构建与版本发布
├── go.mod / go.sum        # Go 模块与依赖
├── servmon.example.yaml   # 配置示例
└── README.md
```

## 开发

在项目根目录执行，需要 Go 1.22+ 和 Make；前端检查需要 Node.js，Go 竞态测试需要 CGO / C 编译器。无需安装 npm 依赖。

```bash
make                       # 构建 bin/servmon
make check                 # Go 竞态测试、vet、JS 测试和脚本语法检查
make test-web              # 仅运行前端测试
make linux                 # 交叉编译 Linux amd64 / arm64
make darwin                # 交叉编译 macOS amd64 / arm64
make release               # 编译上述全部四个平台
make test-install          # 在隔离 Docker 容器中测试安装与回滚
make fmt                   # 格式化 Go 代码
make help                  # 查看全部命令
```

准备好本地配置后，可用 `make run ARGS='-config servmon.yaml'` 构建并启动。Go 入口位于 `./src`，`src/web/` 在构建时嵌入二进制；修改网页资源后需重新构建。
