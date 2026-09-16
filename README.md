# servmon

单文件的个人服务器监控面板。Go 后端 + 内嵌的无依赖网页，`go build` 之后就是一个可执行文件，拷到服务器上直接跑。

功能：CPU（总量 + 每核 + 型号 / 频率 / 温度）、内存 / 交换区 / 缓存、磁盘用量、网络实时流量与历史曲线、进程列表（按 CPU / 内存排序）、systemd 服务的启动 / 停止 / 重启 / 开机自启。

## 构建

```bash
go mod tidy
go build -ldflags="-s -w" -o servmon .

# 交叉编译到 Linux 服务器
GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o servmon .
```

## 运行

```bash
sudo ./servmon -addr :8080 -token 你的密码 -services nginx,docker,sshd
```

| 参数 | 说明 | 默认 |
|---|---|---|
| `-config` | YAML 配置文件路径 | 空（当前目录有 `servmon.yaml` 则自动加载） |
| `-addr` | 监听地址 | `:8080` |
| `-token` | 访问令牌，为空则不鉴权 | 空 |
| `-services` | 允许控制的 systemd 服务，逗号分隔 | 空（不显示服务面板） |
| `-interval` | 采样间隔 | `2s` |

- 配置文件字段与参数同名（见 `servmon.example.yaml`）；命令行显式给出的参数优先于配置文件。
- 页面右上角可切换主题：跟随系统 / 深色 / 浅色，选择保存在浏览器本地；也可用 `?theme=dark|light|auto` 直接指定。
- 控制服务需要 root 权限（或对 `systemctl` 配置 sudo 免密）；只看监控数据用普通用户即可。
- 只有 `-services` 里列出的服务才能被操作，其它名字一律拒绝。
- 暴露到公网请务必设置 `-token`，并建议放在 Nginx / Caddy 后面走 HTTPS。

### 用配置文件启动

```yaml
# /etc/servmon.yaml
addr: ":8080"
token: 你的密码
services: [nginx, docker, sshd]   # 也可写成 "nginx,docker,sshd"
interval: 2s
```

```bash
sudo ./servmon -config /etc/servmon.yaml
```

## 作为系统服务运行

`/etc/systemd/system/servmon.service`：

```ini
[Unit]
Description=servmon 监控面板
After=network.target

[Service]
ExecStart=/usr/local/bin/servmon -config /etc/servmon.yaml
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now servmon
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/overview` | 主机信息、CPU（含型号 / 频率 / 温度）/ 内存 / 磁盘 / 网络及最近 3 分钟历史 |
| GET | `/api/processes?sort=cpu\|mem&limit=all` | 进程列表，默认前 40 个；页面用 `limit=all` 拉全量后本地分页 |
| GET | `/api/services` | 允许列表中各服务的状态（含是否开机自启、当前状态持续秒数） |
| POST | `/api/services/{name}/{start\|stop\|restart\|enable\|disable}` | 控制服务 |

设置了 `-token` 时，请求头需带 `Authorization: Bearer <token>`。

## 目录

```
main.go               后端：采样器、API、服务控制、配置加载
web/index.html        前端：单页，内联 SVG 画曲线，深 / 浅主题，无外部依赖
servmon.example.yaml  配置文件示例
go.mod
```
