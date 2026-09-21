import React, { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  GithubLogo,
  Sun,
  Moon,
  List,
  X,
  Copy,
  Check,
  TerminalWindow,
  Cpu,
  BellRinging,
  ShieldCheck,
  ClockCounterClockwise,
  SlidersHorizontal,
  Cube,
  DownloadSimple,
  BookOpen,
  LinuxLogo,
  AppleLogo,
  CaretRight,
  MagnifyingGlass,
  HardDrives,
  Code,
  Lightning,
} from "@phosphor-icons/react";
const REPO = "https://github.com/DLYZZT/servmon";
const INSTALL = `curl -fsSL ${REPO}/releases/latest/download/install.sh | sudo bash`;
const sections = [
  ["quickstart", "快速开始", "安装 Linux macOS 入门"],
  ["access", "访问控制台", "SSH 令牌 token 隧道 登录"],
  ["configuration", "基础配置", "YAML 端口 采样 权限"],
  ["alerts", "告警与通知", "Telegram Webhook 阈值"],
  ["history", "历史与数据", "30 天 存储 磁盘"],
  ["api", "API 参考", "开发 接口 SSE"],
  ["upgrade", "升级与卸载", "更新 删除 purge"],
];
function CodeBlock({ children, label = "终端" }) {
  const [state, setState] = useState("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(children);
      setState("copied");
    } catch {
      setState("error");
    }
    setTimeout(() => setState("idle"), 2400);
  }
  return (
    <div className="code-block">
      <div className="code-top">
        <span>
          <TerminalWindow size={15} />
          {label}
        </span>
        <button onClick={copy} aria-label="复制命令">
          {state === "copied" ? <Check size={15} /> : <Copy size={15} />}
          <span aria-live="polite">
            {state === "copied"
              ? "已复制"
              : state === "error"
                ? "请手动复制"
                : "复制"}
          </span>
        </button>
      </div>
      <pre>
        <code>{children}</code>
      </pre>
    </div>
  );
}
function Header({ page, theme, toggleTheme }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [page]);
  return (
    <header className="site-header">
      <div className="header-inner">
        <a href="#/" className="brand" aria-label="servmon 首页">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
          <span>
            servmon<span className="brand-period">.</span>
          </span>
        </a>
        <nav
          className={open ? "main-nav open" : "main-nav"}
          aria-label="主导航"
        >
          <a href="#/" aria-current={page === "home" ? "page" : undefined}>
            首页
          </a>
          <a
            href="#/download"
            aria-current={page === "download" ? "page" : undefined}
          >
            下载
          </a>
          <a href="#/docs" aria-current={page === "docs" ? "page" : undefined}>
            文档
          </a>
        </nav>
        <div className="header-actions">
          <button
            className="icon-button"
            onClick={toggleTheme}
            aria-label={theme === "light" ? "切换深色主题" : "切换浅色主题"}
          >
            {theme === "light" ? <Moon size={19} /> : <Sun size={19} />}
          </button>
          <span className="nav-divider" />
          <a
            className="github-link"
            aria-label="GitHub 仓库"
            href={REPO}
            target="_blank"
            rel="noreferrer"
          >
            <GithubLogo size={20} weight="fill" />
            <span>GitHub</span>
            <ArrowUpRight size={14} />
          </a>
          <button
            className="icon-button menu-toggle"
            aria-label={open ? "关闭导航" : "打开导航"}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? <X size={22} /> : <List size={22} />}
          </button>
        </div>
      </div>
    </header>
  );
}
function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-top">
        <a href="#/" className="brand">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
          <span>
            servmon<span className="brand-period">.</span>
          </span>
        </a>
        <p>简单部署，从容掌握。</p>
        <a href={REPO} target="_blank" rel="noreferrer">
          <GithubLogo size={18} /> 在 GitHub 上一起构建{" "}
          <ArrowUpRight size={14} />
        </a>
      </div>
      <div className="footer-bottom">
        <span>为你的服务器，也为你的好奇心。</span>
        <span>
          Built with Go <span className="footer-dot">·</span> Linux & macOS
        </span>
      </div>
    </footer>
  );
}
function Home() {
  const features = [
    [
      Cpu,
      "看清每一项指标",
      "CPU、内存、磁盘与网络，关键状态汇集在一个清晰的面板。",
      "01 / OBSERVE",
    ],
    [
      Cube,
      "从进程到容器",
      "查看进程、管理 systemd 服务和 Docker 容器，少一点来回切换。",
      "02 / CONTROL",
    ],
    [
      BellRinging,
      "异常发生，及时知道",
      "设置持续阈值，通过 Webhook 或 Telegram 接收触发与恢复通知。",
      "03 / NOTIFY",
    ],
    [
      ClockCounterClockwise,
      "让变化有迹可循",
      "保留最长 30 天历史，回看负载变化，找到问题出现的时刻。",
      "04 / REVIEW",
    ],
    [
      ShieldCheck,
      "分享状态，保留控制",
      "独立的管理与只读角色，结合操作审计，让访问边界更清晰。",
      "05 / PROTECT",
    ],
    [
      SlidersHorizontal,
      "用你习惯的方式",
      "中英文、深浅主题、可调整的面板布局，还有随手打开的 PWA。",
      "06 / CUSTOMIZE",
    ],
  ];
  return (
    <main id="main" tabIndex={-1}>
      <section className="home-hero container">
        <div className="eyebrow">
          <span className="status-dot" /> SMALL FOOTPRINT. CLEAR PICTURE.
        </div>
        <div className="hero-heading">
          <h1>
            让服务器状态，
            <br />
            <span>一目了然。</span>
          </h1>
          <div className="hero-aside">
            <p>你的服务器，值得一个清晰的视角。</p>
            <p>
              一个 Go 二进制，一张实时面板。
              <br />
              从系统指标到容器状态，把复杂留给机器。
            </p>
            <div className="hero-actions">
              <a className="button primary" href="#/download">
                开始使用 <ArrowRight size={17} />
              </a>
              <a className="text-link" href="#/docs">
                阅读文档 <ArrowUpRight size={16} />
              </a>
            </div>
          </div>
        </div>
        <div className="hero-meta">
          <span>
            <HardDrives size={15} /> 单文件部署
          </span>
          <span>
            <Lightning size={15} /> SSE 实时更新
          </span>
          <span>
            <Code size={15} /> 无数据库依赖
          </span>
          <span className="meta-platforms">LINUX / MACOS</span>
        </div>
        <div className="dashboard-frame">
          <div className="dashboard-caption">
            <span>
              <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" /> servmon{" "}
              <span className="caption-slash">/</span> overview
            </span>
            <span className="preview-tag">
              产品界面预览 <ArrowUpRight size={13} />
            </span>
          </div>
          <img
            className="dashboard-image"
            src={`${import.meta.env.BASE_URL}assets/dashboard.png`}
            alt="servmon 浅色监控面板：CPU、内存、磁盘、网络流量和各核心使用率"
            fetchPriority="high"
            width="1541"
            height="774"
          />
        </div>
        <div className="screenshot-note">
          <span>真实界面，清晰如你所见。</span>
          <span>你的数据，留在你的服务器上。</span>
        </div>
      </section>
      <section className="feature-section container">
        <div className="section-heading">
          <div>
            <span className="eyebrow">DESIGNED TO STAY SIMPLE</span>
            <h2>
              该有的能力，
              <br />
              恰好的复杂度。
            </h2>
          </div>
          <p>
            为个人服务器与日常运维而生。
            <br />
            从发现异常，到找到原因，再到采取行动。
          </p>
        </div>
        <div className="feature-grid">
          {features.map(([Icon, title, description, tag]) => (
            <article className="feature" key={title}>
              <div className="feature-top">
                <Icon size={25} weight="light" />
                <span>{tag}</span>
              </div>
              <h3>{title}</h3>
              <p>{description}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="start-section container">
        <div>
          <span className="eyebrow">READY WHEN YOU ARE</span>
          <h2>下一步，就从这行命令开始。</h2>
          <p>自动识别系统与架构，下载并校验最新正式版本。</p>
          <a className="text-link" href="#/docs">
            查看完整安装指南 <ArrowRight size={16} />
          </a>
        </div>
        <div>
          <CodeBlock label="BASH / 一键安装">{INSTALL}</CodeBlock>
          <p className="command-note">
            Linux 使用 systemd 运行 · macOS 安装后需手动配置并启动
          </p>
        </div>
      </section>
    </main>
  );
}
function DownloadPage() {
  const [os, setOs] = useState("linux");
  const [arch, setArch] = useState("amd64");
  const binary = `servmon-${os === "linux" ? "linux" : "darwin"}-${arch}`;
  return (
    <main id="main" tabIndex={-1} className="container inner-page">
      <div className="eyebrow">GET SERVMON</div>
      <h1>轻装上阵，即刻开始。</h1>
      <p className="page-intro">选好你的系统，剩下的交给 servmon。</p>
      <div className="download-layout">
        <section className="download-card">
          <div className="card-section-title">
            <span className="step-number">01</span>
            <h2>选择你的平台</h2>
            <span className="tiny-tag">64-BIT</span>
          </div>
          <div className="platform-tabs" role="group" aria-label="操作系统">
            <button
              className={os === "linux" ? "selected" : ""}
              aria-pressed={os === "linux"}
              onClick={() => setOs("linux")}
            >
              <LinuxLogo size={30} />
              <span>
                Linux<small>systemd 发行版</small>
              </span>
              {os === "linux" && <Check size={17} />}
            </button>
            <button
              className={os === "macos" ? "selected" : ""}
              aria-pressed={os === "macos"}
              onClick={() => setOs("macos")}
            >
              <AppleLogo size={30} />
              <span>
                macOS<small>Intel / Apple Silicon</small>
              </span>
              {os === "macos" && <Check size={17} />}
            </button>
          </div>
          <label className="field-label" htmlFor="architecture">
            处理器架构
          </label>
          <select
            id="architecture"
            value={arch}
            onChange={(e) => setArch(e.target.value)}
          >
            <option value="amd64">
              x86_64 / amd64{os === "macos" ? "（Intel）" : ""}
            </option>
            <option value="arm64">
              ARM64 / arm64{os === "macos" ? "（Apple Silicon）" : ""}
            </option>
          </select>
          <a
            className="button primary download-button"
            href={`${REPO}/releases/latest/download/${binary}`}
          >
            <DownloadSimple size={19} /> 下载{" "}
            {os === "linux" ? "Linux" : "macOS"} 版本{" "}
            <span className="download-arch">64 bit</span>
          </a>
          <div className="download-file">
            <code>{binary}</code>
            <span>最新正式版</span>
          </div>
          <p className="download-help">
            {os === "linux"
              ? "支持使用 systemd 的 Linux。在线安装会配置后台服务与开机自启。"
              : "macOS 安装仅复制二进制文件，需准备 YAML 配置并手动启动。systemd 功能仅适用于 Linux。"}
          </p>
          <div className="download-links">
            <a
              href={`${REPO}/releases/latest/download/checksums.txt`}
              target="_blank"
              rel="noreferrer"
            >
              SHA-256 校验 <ArrowUpRight size={14} />
            </a>
            <a href={`${REPO}/releases`} target="_blank" rel="noreferrer">
              全部版本 <ArrowUpRight size={14} />
            </a>
          </div>
        </section>
        <section className="install-guide">
          <span className="recommendation">
            <Lightning size={15} /> 推荐方式
          </span>
          <h2>一行命令，安装或升级。</h2>
          <p>无需安装 Go。脚本自动检测系统与架构，并验证下载文件的 SHA-256。</p>
          <CodeBlock label={`BASH / ${os === "linux" ? "LINUX" : "MACOS"}`}>
            {INSTALL}
          </CodeBlock>
          <div className="info-note">
            <ShieldCheck size={22} />
            <div>
              <strong>升级时，保留你的配置与数据。</strong>
              <p>
                重复运行安装命令即可升级。Linux
                服务启动失败时，安装脚本会尝试回滚。
              </p>
            </div>
          </div>
          <h3>也喜欢自己构建？</h3>
          <p>准备 Go 1.22+，从源码构建一个属于你的版本。</p>
          <CodeBlock label="BASH / 从源码构建">{`git clone ${REPO}.git\ncd servmon\ngo build -trimpath -ldflags="-s -w" -o bin/servmon ./src`}</CodeBlock>
          <a className="text-link" href="#/docs">
            继续阅读安装与配置指南 <ArrowRight size={16} />
          </a>
        </section>
      </div>
      <div className="download-bottom">
        <BookOpen size={27} weight="light" />
        <div>
          <h3>第一次使用？我们从安装开始。</h3>
          <p>访问令牌、远程连接、告警配置，都在文档里。</p>
        </div>
        <a href="#/docs" className="button secondary">
          打开文档 <ArrowRight size={16} />
        </a>
      </div>
    </main>
  );
}
function DocContent({ section }) {
  if (section === "access")
    return (
      <>
        <h1>访问控制台</h1>
        <p className="doc-lead">
          从本机访问，或通过 SSH 隧道连接你的远程服务器。
        </p>
        <h2 id="local">本机访问</h2>
        <p>
          Linux 在线安装默认监听 <code>127.0.0.1:8080</code>
          。在服务器本机的浏览器打开该地址，然后输入安装生成的令牌。
        </p>
        <CodeBlock>{"sudo cat /etc/servmon.yaml"}</CodeBlock>
        <div className="info-note">
          <ShieldCheck size={22} />
          <p>
            配置中的 token 是管理令牌；view_token
            是只读令牌。请妥善保存，按需要分配访问权限。
          </p>
        </div>
        <h2 id="remote">远程访问</h2>
        <p>
          在你自己的电脑运行下方命令，将 <code>user@your-server</code>{" "}
          替换为服务器的 SSH 登录信息。保持连接后，在浏览器打开{" "}
          <code>http://127.0.0.1:8080</code>。
        </p>
        <CodeBlock>{"ssh -L 8080:127.0.0.1:8080 user@your-server"}</CodeBlock>
        <p>也可以配置 HTTPS 反向代理。开放访问前请设置非空管理令牌。</p>
      </>
    );
  if (section === "configuration")
    return (
      <>
        <h1>基础配置</h1>
        <p className="doc-lead">一个 YAML 文件，定义你的监控方式。</p>
        <h2 id="file">配置文件</h2>
        <p>
          Linux 在线安装使用 <code>/etc/servmon.yaml</code>。手动启动可用{" "}
          <code>-config</code> 指定文件。优先级为：程序默认值 → YAML →
          命令行参数。
        </p>
        <CodeBlock label="YAML / 手动运行示例">
          {
            'addr: "127.0.0.1:8080"\ntoken: "replace-with-a-long-random-admin-token"\nview_token: "replace-with-a-different-read-only-token"\nservices: [nginx, sshd]\ninterval: 2s\nproc_interval: 5s\ndata_dir: ./data'
          }
        </CodeBlock>
        <h2 id="fields">常用字段</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>字段</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>addr</td>
                <td>监听地址与端口</td>
              </tr>
              <tr>
                <td>token / view_token</td>
                <td>管理令牌与只读令牌，须使用不同值</td>
              </tr>
              <tr>
                <td>services</td>
                <td>允许监控与控制的 systemd 服务</td>
              </tr>
              <tr>
                <td>interval</td>
                <td>主机采样间隔，至少 200ms</td>
              </tr>
              <tr>
                <td>data_dir</td>
                <td>历史、通知队列和审计日志目录</td>
              </tr>
            </tbody>
          </table>
        </div>
        <h2 id="restart">应用修改</h2>
        <p>配置在启动时加载，修改后需要重启服务。</p>
        <CodeBlock>
          {"sudo systemctl restart servmon\nsudo systemctl status servmon"}
        </CodeBlock>
      </>
    );
  if (section === "alerts")
    return (
      <>
        <h1>告警与通知</h1>
        <p className="doc-lead">在需要关注时收到通知，在恢复正常时安心。</p>
        <h2 id="threshold">设置阈值</h2>
        <p>
          指标达到或超过阈值，并持续达到 sustain 指定时间后触发告警。阈值设为 0
          可关闭对应指标。
        </p>
        <CodeBlock label="YAML / 告警配置">
          {
            "alerts:\n  cpu: 90\n  mem: 90\n  disk: 90\n  load1: 0\n  service_failed: true\n  sustain: 30s\n  cooldown: 10m"
          }
        </CodeBlock>
        <h2 id="channels">连接通知渠道</h2>
        <p>
          Webhook 和 Telegram 可同时启用。Telegram token 与 chat_id
          需要一起配置；没有配置渠道时，仍可在网页中查看告警。
        </p>
        <CodeBlock label="YAML / 通知渠道">
          {
            'notify:\n  webhook: []\n  telegram:\n    token: ""\n    chat_id: ""'
          }
        </CodeBlock>
        <p>
          恢复通知包含异常持续时间。投递失败会重试；修改配置后请重启 servmon。
        </p>
      </>
    );
  if (section === "history")
    return (
      <>
        <h1>历史与数据</h1>
        <p className="doc-lead">从当下的一次波动，到过去 30 天的变化。</p>
        <h2 id="range">历史时间范围</h2>
        <p>
          面板支持 3 分钟、1 小时、24 小时、7 天和 30
          天。实时历史在内存中保存，长时间历史按分钟和十分钟粒度落盘，分别保留
          24 小时和 30 天。
        </p>
        <h2 id="storage">数据存储</h2>
        <p>
          在线安装默认数据目录为 <code>/var/lib/servmon</code>。手动运行可以在
          YAML 中指定相对或绝对路径。
        </p>
        <CodeBlock label="YAML">{"data_dir: ./data"}</CodeBlock>
        <div className="info-note">
          <HardDrives size={22} />
          <p>
            数据目录不可写时会回退到内存模式。控制操作需要可写的审计目录，否则会被拒绝。
          </p>
        </div>
        <h2 id="audit">操作审计</h2>
        <p>
          进程、服务和容器控制操作会写入数据目录下的 <code>audit.log</code>
          ，便于回看操作记录。
        </p>
      </>
    );
  if (section === "api")
    return (
      <>
        <h1>API 参考</h1>
        <p className="doc-lead">将监控数据接入你自己的脚本与工作流。</p>
        <h2 id="auth">鉴权</h2>
        <p>
          通过 Authorization 请求头传入管理或只读令牌。调用前，将环境变量
          SERVMON_TOKEN 设为自己的令牌。
        </p>
        <CodeBlock>
          {
            'curl -H "Authorization: Bearer ${SERVMON_TOKEN}" \\\n  http://127.0.0.1:8080/api/overview'
          }
        </CodeBlock>
        <h2 id="endpoints">常用读取接口</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>方法 / 路径</th>
                <th>返回内容</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["/api/overview", "系统概览与实时历史"],
                ["/api/history?range=24h", "指定时间范围历史"],
                ["/api/alerts", "活跃告警与近期记录"],
                ["/api/processes", "进程列表"],
                ["/api/services", "systemd 服务状态"],
                ["/api/containers", "Docker 容器状态"],
                ["/api/stream", "SSE 实时事件流"],
              ].map(([path, desc]) => (
                <tr key={path}>
                  <td>
                    <code>GET {path}</code>
                  </td>
                  <td>{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          更多鉴权、写操作和响应细节请查阅
          <a href={REPO} target="_blank" rel="noreferrer">
            仓库文档
          </a>
          。
        </p>
      </>
    );
  if (section === "upgrade")
    return (
      <>
        <h1>升级与卸载</h1>
        <p className="doc-lead">保持更新，也保留对服务器的完整掌控。</p>
        <h2 id="update">升级</h2>
        <p>
          重复运行在线安装命令，即可升级到最新正式版本。已有配置、令牌和数据会保留。
        </p>
        <CodeBlock>{INSTALL}</CodeBlock>
        <h2 id="remove">卸载程序</h2>
        <p>
          以下命令删除程序；Linux 同时停止并禁用 systemd
          服务。默认保留配置、令牌与数据。
        </p>
        <CodeBlock>{`curl -fsSL ${REPO}/releases/latest/download/install.sh -o install.sh\nsudo bash install.sh --uninstall`}</CodeBlock>
        <div className="info-note">
          <BookOpen size={22} />
          <p>
            macOS 卸载仅删除二进制，请先自行停止手动运行的进程。需要彻底清理
            Linux 数据时，请先阅读仓库 README 中的 --purge 说明。
          </p>
        </div>
      </>
    );
  return (
    <>
      <h1>快速开始</h1>
      <p className="doc-lead">从一行安装命令，到你的第一张监控面板。</p>
      <div className="doc-callout">
        <Lightning size={21} />
        <div>
          <strong>运行无需 Go，也无需数据库。</strong>
          <p>支持 Linux 与 macOS 的 x86_64 和 ARM64 架构。</p>
        </div>
      </div>
      <h2 id="requirements">开始之前</h2>
      <p>
        在线安装需要 Bash、curl 或 wget、SHA-256 工具以及 root 权限。Linux
        还需要 systemd；macOS 安装后需要手动配置并启动。
      </p>
      <h2 id="install">
        <span className="step-number">01</span> 安装 servmon
      </h2>
      <p>在服务器终端运行以下命令，自动下载并校验最新正式版本。</p>
      <CodeBlock>{INSTALL}</CodeBlock>
      <p>Linux 上，脚本会安装程序、生成管理和只读令牌，并启用开机自启。</p>
      <h2 id="token">
        <span className="step-number">02</span> 获取访问令牌
      </h2>
      <p>
        Linux 上，查看配置文件中的 <code>token</code> 字段，用于登录管理界面。
        macOS 请按下方「macOS 手动启动」准备配置。
      </p>
      <CodeBlock>{"sudo cat /etc/servmon.yaml"}</CodeBlock>
      <h2 id="open">
        <span className="step-number">03</span> 打开你的监控面板
      </h2>
      <p>
        默认地址为 <code>http://127.0.0.1:8080</code>
        。远程访问时，在自己的电脑建立 SSH 隧道：
      </p>
      <CodeBlock>{"ssh -L 8080:127.0.0.1:8080 user@your-server"}</CodeBlock>
      <p>
        将 user@your-server
        替换为你的登录信息，在本机浏览器打开上述地址并输入令牌。
      </p>
      <h2 id="macos">macOS 手动启动</h2>
      <p>
        先使用安装命令或下载页获取二进制。随后准备配置文件，设置令牌和可写数据目录，再启动程序：
      </p>
      <CodeBlock label="YAML / servmon.yaml">
        {
          'addr: "127.0.0.1:8080"\ntoken: "replace-with-a-long-random-token"\ndata_dir: ./data'
        }
      </CodeBlock>
      <CodeBlock>{"servmon -config ./servmon.yaml"}</CodeBlock>
      <p>
        直接下载的二进制需先添加执行权限，例如{" "}
        <code>chmod +x servmon-darwin-arm64</code>，再用该文件路径启动。
      </p>
    </>
  );
}
function Docs({ section = "quickstart" }) {
  const [query, setQuery] = useState("");
  const [headings, setHeadings] = useState([]);
  const active = sections.some(([id]) => id === section)
    ? section
    : "quickstart";
  const current = sections.findIndex(([id]) => id === active);
  useEffect(
    () =>
      setHeadings(
        [...document.querySelectorAll(".doc-article h2")].map((el) => ({
          id: el.id,
          text: el.textContent,
        })),
      ),
    [active],
  );
  const filtered = sections.filter((s) =>
    s.join(" ").toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <main id="main" tabIndex={-1} className="container docs-layout">
      <aside className="docs-sidebar">
        <div className="docs-label">
          <BookOpen size={18} /> 使用文档
        </div>
        <label className="search-box">
          <MagnifyingGlass size={17} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="查找文档…"
            aria-label="查找文档"
          />
        </label>
        <span className="sidebar-group">开始使用</span>
        <nav aria-label="文档导航">
          {filtered.map(([id, title]) => (
            <a
              key={id}
              href={`#/docs/${id}`}
              aria-current={active === id ? "page" : undefined}
            >
              {title}
              {active === id && <CaretRight size={13} />}
            </a>
          ))}
          {!filtered.length && <p className="no-results">没有匹配的文档</p>}
        </nav>
        <a
          className="sidebar-github"
          href={REPO}
          target="_blank"
          rel="noreferrer"
        >
          <GithubLogo size={18} /> 查看源代码 <ArrowUpRight size={13} />
        </a>
      </aside>
      <article className="doc-article" key={active}>
        <div className="breadcrumbs">
          文档 <CaretRight size={12} /> {sections[current][1]}
        </div>
        <DocContent section={active} />
        <div className="doc-pagination">
          {current > 0 && (
            <a href={`#/docs/${sections[current - 1][0]}`}>
              <small>上一篇</small>
              {sections[current - 1][1]}
            </a>
          )}
          {current < sections.length - 1 && (
            <a className="next-doc" href={`#/docs/${sections[current + 1][0]}`}>
              <small>继续阅读</small>
              {sections[current + 1][1]} <ArrowRight size={16} />
            </a>
          )}
        </div>
      </article>
      <aside className="doc-toc">
        <span>本页内容</span>
        {headings.map((h) => (
          <button
            key={h.id}
            onClick={() =>
              document
                .getElementById(h.id)
                ?.scrollIntoView({ behavior: "smooth" })
            }
          >
            {h.text.replace(/^0\d\s*/, "")}
          </button>
        ))}
        <div className="toc-help">
          <p>让监控保持简单。</p>
          <a href="#/download">
            下载 servmon <ArrowRight size={13} />
          </a>
        </div>
      </aside>
    </main>
  );
}
export function App() {
  const [route, setRoute] = useState(window.location.hash || "#/");
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("servmon-site-theme") === "dark"
        ? "dark"
        : "light";
    } catch {
      return "light";
    }
  });
  const page = route.startsWith("#/download")
    ? "download"
    : route.startsWith("#/docs")
      ? "docs"
      : "home";
  useEffect(() => {
    const update = () => {
      setRoute(window.location.hash);
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [route]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("servmon-site-theme", theme);
    } catch {}
  }, [theme]);
  useEffect(() => {
    document.title = `${page === "home" ? "让服务器状态，一目了然" : page === "download" ? "下载" : "文档"} — servmon`;
  }, [page]);
  return (
    <>
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        跳转到正文
      </a>
      <Header
        page={page}
        theme={theme}
        toggleTheme={() => setTheme(theme === "light" ? "dark" : "light")}
      />
      {page === "home" ? (
        <Home />
      ) : page === "download" ? (
        <DownloadPage />
      ) : (
        <Docs section={route.split("/")[2]} />
      )}
      <Footer />
    </>
  );
}
