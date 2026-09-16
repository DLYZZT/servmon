"use strict";
const I18n = (() => {
  let language = navigator.language.toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
  try {
    const saved = localStorage.getItem("servmon.lang");
    if (["zh", "en"].includes(saved)) language = saved;
  } catch {}
  const messages = {
    基础信息: "Overview",
    "正在连接 Docker…": "Connecting to Docker…",
    "Docker 暂不可用，请确认 Docker 已启动且 servmon 有访问权限。":
      "Docker is unavailable. Check that Docker is running and servmon has access.",
    告警: "Alerts",
    退出: "Log out",
    时间范围: "Time range",
    "3 分钟": "3 minutes",
    "1 小时": "1 hour",
    "24 小时": "24 hours",
    "7 天": "7 days",
    "30 天": "30 days",
    "负载 1/5/15": "Load 1/5/15",
    本地时间: "Local time",
    内存: "Memory",
    磁盘: "Disks",
    网络: "Network",
    网络流量: "Network traffic",
    每核占用: "Per-core usage",
    进程: "Processes",
    系统服务: "Services",
    "按 CPU": "By CPU",
    按内存: "By memory",
    命令: "Command",
    用户: "User",
    关闭: "Close",
    进入: "Sign in",
    日志: "Logs",
    "Docker 容器": "Docker containers",
    "需要访问令牌才能查看此面板。": "An access token is required.",
    输入令牌: "Access token",
    "搜索名称 / 用户 / PID": "Search name / user / PID",
    "自动 / 总流量": "Auto / aggregate",
    管理权限: "Administrator",
    只读模式: "Read only",
    内存模式: "Memory only",
    "加载历史…": "Loading history…",
    个采样点: "samples",
    此时间范围暂无历史数据: "No history in this range yet",
    暂无数据: "No data",
    暂无告警: "No alerts",
    触发: "Firing",
    已恢复: "Resolved",
    开始于: "Since",
    活跃告警: "Active alerts",
    "最近 50 条记录": "Latest 50 events",
    告警与通知: "Alerts and notifications",
    服务日志: "Service logs",
    自动跟随: "Follow logs",
    暂无日志: "No log entries",
    进程详情: "Process details",
    "加载中…": "Loading…",
    权限不足或不支持: "Unavailable or permission denied",
    命令行: "Command line",
    工作目录: "Working directory",
    启动时间: "Started",
    线程数: "Threads",
    打开文件数: "Open files",
    结束进程: "Terminate",
    强制结束: "Force kill",
    确定结束进程: "Terminate process",
    操作完成: "Done",
    没有容器: "No containers",
    确认容器操作: "Confirm container action",
    停止: "Stop",
    启动: "Start",
    重启: "Restart",
    令牌不正确: "Invalid token",
    "主题 自动": "Theme: Auto",
    "主题 深色": "Theme: Dark",
    "主题 浅色": "Theme: Light",
    "● 实时刷新": "● Live",
    "○ 已暂停": "○ Paused",
    "已离线 · 显示最后一次数据": "Offline · showing last data",
    移动到图上查看数值: "Hover over a chart for values",
    "↓ 下行": "↓ Download",
    "↑ 上行": "↑ Upload",
    "— 下行": "— Download",
    "— 上行": "— Upload",
    暂无历史: "No history",
    运行中: "Running",
    已停止: "Stopped",
    失败: "Failed",
    未知: "Unknown",
    未激活: "Inactive",
    启动中: "Starting",
    停止中: "Stopping",
    重启中: "Restarting",
    处理中: "Working",
    没有找到磁盘: "No disks found",
    没有进程数据: "No processes found",
    峰值: "Peak",
    缓存: "Cached",
    累计: "Total",
    温度: "Temperature",
    频率: "Frequency",
    核: "cores",
    个挂载点: "mounts",
    物理核: "physical cores",
    线程: "threads",
    运行: "Uptime",
    内核: "Kernel",
    "Swap 无": "No swap",
    天: "d",
    小时: "h",
    分: "m",
    自启: "Boot",
    开: "On",
    关: "Off",
    已运行: "Running for",
    个服务运行中: "services running",
    共: "of",
    个: "items",
    刚刚: "just now",
    近: "Last",
    分钟: "minutes",
    秒: "seconds",
  };
  Object.assign(messages, {
    连接中: "Connecting",
    "正在连接…": "Connecting…",
    在线: "Online",
    监控页面: "Monitoring pages",
    访问令牌: "Access token",
    搜索进程: "Search processes",
    网络接口: "Network interface",
    历史曲线: "History chart",
    上一页: "Previous page",
    下一页: "Next page",
    "切换主题：跟随系统 / 深色 / 浅色": "Switch theme: system / dark / light",
    切换语言: "Switch language",
    开启自启: "Enable at boot",
    关闭自启: "Disable at boot",
    完成: "Done",
    "内核 {version}": "Kernel {version}",
    "运行 {duration}": "Uptime {duration}",
    "{count} 天": { one: "{count} day", other: "{count} days" },
    "{count} 小时": { one: "{count} hour", other: "{count} hours" },
    "{count} 分": { one: "{count} minute", other: "{count} minutes" },
    "{days}天 {hours}小时": "{days}d {hours}h",
    "{hours}小时 {minutes}分": "{hours}h {minutes}m",
    "{count}分": "{count}m",
    "{count} 核": { one: "{count} core", other: "{count} cores" },
    "{count} 个挂载点": { one: "{count} mount", other: "{count} mounts" },
    "{count} 个采样点": { one: "{count} sample", other: "{count} samples" },
    "{physical} 物理核 / {cores} 线程":
      "{physical} physical cores / {cores} threads",
    "缓存 {size}": "Cached {size}",
    "累计 {rx} ↓ · {tx} ↑": "Total {rx} ↓ · {tx} ↑",
    "温度 {value}": "Temperature {value}",
    "频率 {value}": "Frequency {value}",
    "进程 {count}": "Processes {count}",
    "{from}–{to} / 共 {count} 个": "{from}–{to} of {count} processes",
    "{running}/{total} 个服务运行中": "{running}/{total} services running",
    "已运行 {duration}": "Running for {duration}",
    "已停止 {duration}": "Stopped for {duration}",
    "自启 {state}": "Boot {state}",
    "未配置系统服务。请在配置文件的 services 中添加服务名称。":
      "No system services configured. Add service names to services in your configuration file.",
    "确定{action}服务“{name}”？": "{action} service “{name}”?",
    "{name}：{action}中…": "{name}: {action} in progress…",
    "{name}：{action}完成": "{name}: {action} completed",
    "{name}：{action}失败，{error}": "{name}: {action} failed. {error}",
    "操作失败：{error}": "Operation failed: {error}",
    "确定结束进程 {pid}（{signal}）？": "Terminate process {pid} ({signal})?",
    "确定{action}容器“{name}”？": "{action} container “{name}”?",
    负载: "Load",
    "磁盘 {name}": "Disk {name}",
    "服务 {name}": "Service {name}",
    "{rule}：当前 {value}，阈值 {threshold}":
      "{rule}: value {value}, threshold {threshold}",
    "{rule}已恢复，异常持续 {duration}": "{rule} recovered after {duration}",
    休眠: "Sleeping",
    已创建: "Created",
    重启中: "Restarting",
    已暂停: "Paused",
    已退出: "Exited",
    删除中: "Removing",
    已死亡: "Dead",
    僵尸进程: "Zombie",
    已启用: "Enabled",
    已禁用: "Disabled",
    静态: "Static",
    已屏蔽: "Masked",
    间接启用: "Indirect",
    已生成: "Generated",
    临时: "Transient",
    就绪: "Idle",
    "登录已失效，请重新登录。":
      "Your session has expired. Please sign in again.",
    "登录尝试过多，请在 {seconds} 秒后重试。":
      "Too many sign-in attempts. Try again in {seconds} seconds.",
    "请求来源无效。": "The request origin is not allowed.",
    "登录请求无效。": "Invalid sign-in request.",
    "无法创建会话，请稍后重试。":
      "Unable to create a session. Please try again later.",
    "会话过多，请稍后重试。":
      "Too many active sessions. Please try again later.",
    "只读权限无法执行此操作。":
      "Read-only access cannot perform this operation.",
    "审计日志不可写，操作未执行。":
      "The audit log is not writable. The operation was not performed.",
    "进程编号无效。": "Invalid process ID.",
    "进程不存在或无法读取。": "The process no longer exists or cannot be read.",
    "不能结束系统或 servmon 自身进程。":
      "System processes and servmon itself cannot be terminated.",
    "信号必须为 TERM 或 KILL。": "The signal must be TERM or KILL.",
    "进程已变化，请重新打开详情。":
      "The process has changed. Reopen its details before continuing.",
    "无法结束进程，请检查权限和进程状态。":
      "Unable to terminate the process. Check permissions and process state.",
    "服务不在允许列表中。": "This service is not in the allowlist.",
    "不支持此服务操作。": "This service action is not supported.",
    "服务操作失败，请检查 systemd、服务状态及权限。":
      "Service action failed. Check systemd, service state and permissions.",
    "无法读取服务日志，请检查 journalctl 和访问权限。":
      "Unable to read service logs. Check journalctl availability and access permissions.",
    "无效的时间范围。": "Invalid time range.",
    "无效的网络接口。": "Invalid network interface.",
    "网络接口已不可用。": "The network interface is no longer available.",
    "不支持此容器操作。": "This container action is not supported.",
    "容器已不存在，请刷新后重试。":
      "The container no longer exists. Refresh and try again.",
    "容器操作失败，请检查 Docker 状态和权限。":
      "Container action failed. Check Docker availability and permissions.",
    "实时连接不可用，请稍后重试。":
      "The live connection is unavailable. Please try again later.",
    "请求超时，请稍后重试。": "The request timed out. Please try again.",
    "无法连接服务器，请检查网络。":
      "Unable to connect to the server. Check your network.",
    "服务器响应无效，请稍后重试。":
      "Invalid server response. Please try again later.",
    "请求失败（HTTP {status}）。": "Request failed (HTTP {status}).",
    恢复默认布局: "Restore default layout",
    "确定恢复默认布局？": "Restore the default panel layout?",
    布局已恢复: "Default layout restored",
    移动面板: "Move panel",
    "移动到…": "Move to…",
    目标位置: "Destination",
    面板位置: "Position",
    最前: "First",
    最后: "Last",
    取消: "Cancel",
    移动: "Move",
    "基础信息 · 指标": "Overview · Metrics",
    "基础信息 · 图表": "Overview · Charts",
    "基础信息 · 其它面板": "Overview · Other panels",
    "拖动“{panel}”以移动；Alt + 方向键调整位置":
      "Drag “{panel}” to move it; Alt + arrow keys to reorder",
    "移动“{panel}”": "Move “{panel}”",
    "将面板拖到这里，或使用其它面板的“移动到…”":
      "Drop a panel here, or use “Move to…” on another panel.",
    "已将“{panel}”移至{destination}": "Moved “{panel}” to {destination}",
    "放到{destination}": "Drop in {destination}",
    "放到“{panel}”之前": "Drop before “{panel}”",
    "放到“{panel}”之后": "Drop after “{panel}”",
    "无法保存布局，刷新后可能恢复默认。":
      "Unable to save the layout. It may reset after a refresh.",
  });
  Object.assign(messages, {
    "缓存 —": "Cached —",
    "累计 —": "Total —",
    "近 3 分钟": "Last 3 minutes",
    "温度 —": "Temperature —",
    "频率 —": "Frequency —",
    "进程 —": "Processes —",
  });
  Object.assign(messages, { 确认操作: "Confirm action", 确认: "Confirm" });
  Object.assign(messages, {
    "{count} 秒": { one: "{count} second", other: "{count} seconds" },
  });
  const errors = {
    unauthorized: "登录已失效，请重新登录。",
    rate_limited: "登录尝试过多，请在 {seconds} 秒后重试。",
    invalid_origin: "请求来源无效。",
    invalid_login: "登录请求无效。",
    session_unavailable: "无法创建会话，请稍后重试。",
    too_many_sessions: "会话过多，请稍后重试。",
    read_only: "只读权限无法执行此操作。",
    audit_unavailable: "审计日志不可写，操作未执行。",
    invalid_pid: "进程编号无效。",
    process_unavailable: "进程不存在或无法读取。",
    protected_pid: "不能结束系统或 servmon 自身进程。",
    invalid_signal: "信号必须为 TERM 或 KILL。",
    process_changed: "进程已变化，请重新打开详情。",
    process_control_failed: "无法结束进程，请检查权限和进程状态。",
    service_not_allowed: "服务不在允许列表中。",
    unsupported_service_action: "不支持此服务操作。",
    service_control_failed: "服务操作失败，请检查 systemd、服务状态及权限。",
    logs_unavailable: "无法读取服务日志，请检查 journalctl 和访问权限。",
    invalid_range: "无效的时间范围。",
    invalid_interface: "无效的网络接口。",
    unknown_interface: "网络接口已不可用。",
    unsupported_container_action: "不支持此容器操作。",
    unknown_container: "容器已不存在，请刷新后重试。",
    container_control_failed: "容器操作失败，请检查 Docker 状态和权限。",
    stream_unavailable: "实时连接不可用，请稍后重试。",
    timeout: "请求超时，请稍后重试。",
    network: "无法连接服务器，请检查网络。",
    invalid_response: "服务器响应无效，请稍后重试。",
  };
  function t(key, values = {}) {
    let template =
      language === "en"
        ? Object.hasOwn(messages, key)
          ? messages[key]
          : key
        : key;
    if (typeof template === "object")
      template =
        template[new Intl.PluralRules("en").select(Number(values.count))] ||
        template.other;
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      values[name] == null ? match : String(values[name]),
    );
  }
  const locale = () => (language === "en" ? "en-US" : "zh-CN");
  function apply(root = document) {
    for (const [attribute, target] of [
      ["data-i18n", null],
      ["data-i18n-title", "title"],
      ["data-i18n-label", "aria-label"],
      ["data-i18n-placeholder", "placeholder"],
    ]) {
      const nodes = [...root.querySelectorAll(`[${attribute}]`)];
      if (root.matches?.(`[${attribute}]`)) nodes.unshift(root);
      for (const node of nodes) {
        const value = t(node.getAttribute(attribute));
        if (target) node.setAttribute(target, value);
        else node.textContent = value;
      }
    }
    document.documentElement.lang = locale();
    for (const selector of ["#language", "#loginLanguage"]) {
      const button = document.querySelector(selector);
      if (button) {
        button.textContent = language === "en" ? "中文" : "EN";
        button.setAttribute("aria-label", t("切换语言"));
      }
    }
  }
  function setLanguage(value) {
    if (!["zh", "en"].includes(value)) return;
    language = value;
    try {
      localStorage.setItem("servmon.lang", value);
    } catch {}
    apply();
  }
  function error(code, status, seconds) {
    return t(
      Object.hasOwn(errors, code)
        ? errors[code]
        : "请求失败（HTTP {status}）。",
      {
        status,
        seconds,
      },
    );
  }
  return {
    t,
    locale,
    apply,
    setLanguage,
    error,
    get language() {
      return language;
    },
  };
})();
