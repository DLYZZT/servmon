"use strict";
const $ = (s) => document.querySelector(s);
const tr = I18n.t;
I18n.apply();
try {
  localStorage.removeItem("servmon.token");
} catch {}
let role = "view";
let stream = null;
let watchdog = null,
  lastStreamEvent = 0;
let range = "3m",
  selectedIface = "",
  historyData = [],
  latestOverview = null,
  historyRequest = 0,
  historyFetched = 0;
let alertData = { active: [], history: [] };
let authenticated = false;
let bootstrapTimer = null;
let sortBy = "cpu";
const PAGE_SIZE = 15;
let page = 0;
let live = true;
let intervalMs = 2000;
let tickTimer = null;
let inFlight = false;
let lastLog = null;
let online = null,
  persistent = true;
let containerData = null;
const pending = new Map(); // 服务名 -> 正在执行的动作
const cache = { procs: [], svcs: [] };

// ---------- Page tabs (all panels share the same live connection) ----------
const pageTabs = [...document.querySelectorAll(".page-tab")];
function showTab(name, { focus = false, updateURL = true } = {}) {
  const selected =
    pageTabs.find((tab) => tab.dataset.tab === name) || pageTabs[0];
  for (const tab of pageTabs) {
    const active = tab === selected;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.getAttribute("aria-controls")).hidden = !active;
  }
  if (updateURL) history.replaceState(null, "", "#" + selected.dataset.tab);
  if (focus) selected.focus();
  syncHistoryControls();
}
for (const tab of pageTabs) {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
  tab.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    let index = pageTabs.indexOf(tab);
    switch (event.key) {
      case "ArrowRight":
        index = (index + 1) % pageTabs.length;
        break;
      case "ArrowLeft":
        index = (index + pageTabs.length - 1) % pageTabs.length;
        break;
      case "Home":
        index = 0;
        break;
      case "End":
        index = pageTabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    showTab(pageTabs[index].dataset.tab, { focus: true });
  });
}
window.addEventListener("hashchange", () =>
  showTab(location.hash.slice(1), { updateURL: false }),
);
showTab(location.hash.slice(1), { updateURL: false });

function showPanel(id) {
  const panel = document.querySelector(`[data-panel="${id}"]`);
  if (panel) showTab(panel.closest(".tab-panel").dataset.page);
}
function syncHistoryControls() {
  $("#historyControls").hidden = !document.querySelector(
    '.tab-panel:not([hidden]) [data-panel="cpu"], .tab-panel:not([hidden]) [data-panel="traffic"]',
  );
}
// ---------- 工具 ----------
function bytes(n, f = 1) {
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  n = Number(n) || 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(i === 0 ? 0 : f) + " " + u[i];
}
const rate = (n) => bytes(n, 1) + "/s";
function dur(s) {
  s = Math.max(0, Math.floor(s));
  const d = Math.floor(s / 86400),
    h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60);
  return [
    d ? tr("{count} 天", { count: d }) : "",
    h ? tr("{count} 小时", { count: h }) : "",
    tr("{count} 分", { count: m }),
  ]
    .filter(Boolean)
    .join(" ");
}
function durShort(s) {
  s = Math.max(0, Math.floor(s));
  if (s < 60) return tr("刚刚");
  const d = Math.floor(s / 86400),
    h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60);
  return d
    ? tr("{days}天 {hours}小时", { days: d, hours: h })
    : h
      ? tr("{hours}小时 {minutes}分", { hours: h, minutes: m })
      : tr("{count}分", { count: m });
}
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const heat = (v) => (v > 85 ? "bad" : v > 60 ? "warn" : "");
function setHeat(el, v, prefix) {
  el.classList.remove(prefix + "-warn", prefix + "-bad");
  const h = heat(v);
  if (h) el.classList.add(prefix + "-" + h);
}
function toast(msg, err = false, ms = 2500) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", err);
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), ms);
}
function setLog(msg) {
  lastLog = msg;
  renderLog();
}
function setOnline(ok) {
  online = ok;
  $("#top").classList.toggle("off", !ok);
  $("#badge").textContent = ok ? tr("在线") : tr("已离线 · 显示最后一次数据");
}

// 把序列映射成 SVG 折线的 points 字符串；n 为满幅点数，数据不足时靠右对齐
function poly(vals, max, w, h, n) {
  n = Math.max(n || vals.length, 2);
  const off = n - vals.length;
  const samples = chartSamples();
  const start = samples[0]?.t,
    end = samples[samples.length - 1]?.t;
  return vals
    .map(
      (v, i) =>
        `${(samples.length === vals.length && end > start ? ((samples[i].t - start) / (end - start)) * w : ((i + off) / (n - 1)) * w).toFixed(1)},${(h - Math.max(0, Math.min(1, v / max)) * h).toFixed(1)}`,
    )
    .join(" ");
}
function area(points, vals, w, h, n) {
  if (!vals.length) return "";
  n = Math.max(n || vals.length, 2);
  const x0 = (((n - vals.length) / (n - 1)) * w).toFixed(1);
  return `${x0},${h} ${points} ${w},${h}`;
}

function confirmAction(message) {
  let dialog = $("#confirmDialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "confirmDialog";
    dialog.setAttribute("aria-labelledby", "confirmTitle");
    dialog.setAttribute("aria-describedby", "confirmMessage");
    document.body.appendChild(dialog);
  }
  if (dialog.open) return Promise.resolve(false);
  dialog.innerHTML = `<form method="dialog"><h2 id="confirmTitle" data-i18n="确认操作"></h2><p id="confirmMessage"></p><div class="dialog-actions"><button class="live" value="cancel" autofocus data-i18n="取消"></button><button class="live danger" value="confirm" data-i18n="确认"></button></div></form>`;
  dialog.querySelector("#confirmMessage").textContent = message;
  I18n.apply(dialog);
  dialog.returnValue = "";
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "confirm"),
      { once: true },
    );
    dialog.showModal();
  });
}
class APIError extends Error {
  constructor(code, status = 0, details = "", seconds = 60) {
    super();
    this.code = code;
    this.status = status;
    this.details = details;
    this.seconds = seconds;
  }
  get message() {
    return I18n.error(this.code, this.status, this.seconds);
  }
}
async function api(path, opts = {}) {
  let r;
  try {
    r = await fetch(path, {
      ...opts,
      signal: opts.signal || AbortSignal.timeout(12000),
    });
  } catch (e) {
    throw new APIError(
      e.name === "TimeoutError" || e.name === "AbortError"
        ? "timeout"
        : "network",
    );
  }
  if (r.status === 401) {
    try {
      sessionStorage.removeItem("servmon.last");
    } catch {}
    showLogin();
    throw new APIError("unauthorized", 401);
  }
  let data;
  try {
    data = await r.json();
  } catch {
    throw new APIError("invalid_response", r.status);
  }
  if (!r.ok)
    throw new APIError(
      data.code,
      r.status,
      data.error,
      Number(r.headers.get("Retry-After")) || 60,
    );
  return data;
}
function stateLabel(value) {
  const names = {
    running: "运行中",
    active: "运行中",
    sleep: "休眠",
    sleeping: "休眠",
    idle: "就绪",
    stopped: "已停止",
    inactive: "已停止",
    failed: "失败",
    unknown: "未知",
    created: "已创建",
    restarting: "重启中",
    paused: "已暂停",
    exited: "已退出",
    removing: "删除中",
    dead: "已死亡",
    zombie: "僵尸进程",
    enabled: "已启用",
    disabled: "已禁用",
    static: "静态",
    masked: "已屏蔽",
    indirect: "间接启用",
    generated: "已生成",
    transient: "临时",
  };
  return Object.hasOwn(names, value) ? tr(names[value]) : value;
}
// ---------- 渲染 ----------
function renderOverview(o) {
  const c = o.current || {};
  latestOverview = o;
  try {
    if (o.current?.t) sessionStorage.setItem("servmon.last", JSON.stringify(o));
  } catch {}
  if (range === "3m" && selectedIface) {
    const nic = (o.interfaces || []).find((n) => n.name === selectedIface);
    if (nic && o.current?.t) {
      const sample = { ...o.current, rx: nic.rx, tx: nic.tx };
      historyData = historyData.filter(
        (x) => x.t >= sample.t - 180 && x.t !== sample.t,
      );
      historyData.push(sample);
      historyData.sort((a, b) => a.t - b.t);
      if (historyFetched)
        $("#historyStatus").textContent = tr("{count} 个采样点", {
          count: historyData.length,
        });
    }
  }
  const hist = range === "3m" && !selectedIface ? o.history || [] : historyData;
  const n = Math.max(hist.length, 2);
  if (o.interval > 0) intervalMs = Math.max(500, o.interval * 1000);

  document.title = (o.host || "servmon") + " · servmon";
  $("#host").textContent = o.host || "—";
  $("#sys").textContent = [
    o.os,
    o.kernel ? tr("内核 {version}", { version: o.kernel }) : "",
    tr("运行 {duration}", { duration: dur(o.uptime) }),
  ]
    .filter(Boolean)
    .join(" · ");
  $("#load").textContent = (o.load || [0, 0, 0])
    .map((x) => x.toFixed(2))
    .join(" / ");

  // CPU
  const cpuV = $("#cpuV");
  cpuV.textContent = (c.cpu || 0).toFixed(1);
  setHeat(cpuV, c.cpu || 0, "heat");
  $("#cpuModel").textContent =
    o.cpuModel || tr("{count} 核", { count: o.cores });
  $("#cpuModel").title = o.cpuModel || "";
  const cpuPts = poly(
    hist.map((s) => s.cpu),
    100,
    300,
    70,
    n,
  );
  $("#cpuLine").setAttribute("points", cpuPts);
  $("#cpuArea").setAttribute("points", area(cpuPts, hist, 300, 70, n));

  // 内存
  const memPct = c.mem || 0;
  const memV = $("#memV");
  memV.textContent = memPct.toFixed(0);
  setHeat(memV, memPct, "heat");
  $("#memText").textContent = `${bytes(o.memUsed)} / ${bytes(o.memTotal, 0)}`;
  const memBar = $("#memBar");
  memBar.style.width = memPct.toFixed(1) + "%";
  setHeat(memBar, memPct, "bg");
  $("#swapText").textContent = o.swapTotal
    ? `Swap ${bytes(o.swapUsed)} / ${bytes(o.swapTotal, 0)}`
    : tr("Swap 无");
  $("#cacheText").textContent = tr("缓存 {size}", { size: bytes(o.memCached) });

  // 磁盘
  const disks = o.disks || [];
  $("#diskCount").textContent = tr("{count} 个挂载点", { count: disks.length });
  $("#disks").innerHTML =
    disks
      .map(
        (d) => `
    <div class="disk">
      <div class="l"><span class="mnt" title="${esc(d.fs)}">${esc(d.mount)}</span><span class="u ${heat(d.percent) ? "heat-" + heat(d.percent) : ""}">${bytes(d.used)} / ${bytes(d.total, 0)} · ${d.percent.toFixed(0)}%</span></div>
      <div class="bar s"><i class="${heat(d.percent) ? "bg-" + heat(d.percent) : ""}" style="width:${d.percent.toFixed(1)}%"></i></div>
      <div class="note">R ${rate(d.read || 0)} · W ${rate(d.write || 0)}</div>
    </div>`,
      )
      .join("") || `<div class="empty">${tr("没有找到磁盘")}</div>`;

  // 网络
  const interfaces = o.interfaces || [];
  if (
    !$("#iface").options.length ||
    [...$("#iface").options]
      .slice(1)
      .map((x) => x.value)
      .join() !== interfaces.map((x) => x.name).join()
  ) {
    $("#iface").innerHTML =
      '<option value="">' +
      tr("自动 / 总流量") +
      "</option>" +
      interfaces
        .map((n) => `<option value="${esc(n.name)}">${esc(n.name)}</option>`)
        .join("");
    if (!selectedIface && interfaces.length)
      selectedIface = [...interfaces].sort(
        (a, b) => b.rxTotal + b.txTotal - (a.rxTotal + a.txTotal),
      )[0].name;
    $("#iface").value = selectedIface;
  }
  const nic = interfaces.find((n) => n.name === selectedIface);
  const net = nic || {
    rx: c.rx,
    tx: c.tx,
    rxTotal: o.netRxTotal,
    txTotal: o.netTxTotal,
  };
  $("#rxV").textContent = rate(net.rx || 0);
  $("#txV").textContent = rate(net.tx || 0);
  $("#netTotal").textContent = tr("累计 {rx} ↓ · {tx} ↑", {
    rx: bytes(net.rxTotal),
    tx: bytes(net.txTotal),
  });
  const rxs = hist.map((s) => s.rx),
    txs = hist.map((s) => s.tx);
  const peak = Math.max(1, ...rxs, ...txs);
  const netMax = peak * 1.15;
  const rxPts = poly(rxs, netMax, 600, 180, n);
  $("#rxLine").setAttribute("points", rxPts);
  $("#rxArea").setAttribute("points", area(rxPts, rxs, 600, 180, n));
  $("#txLine").setAttribute("points", poly(txs, netMax, 600, 180, n));
  $("#netRange").textContent =
    `${$("#range").selectedOptions[0].textContent} · ${tr("峰值")} ${rate(peak)}`;

  renderAxes(hist, netMax);
  if (
    (range !== "3m" || selectedIface) &&
    (!historyFetched || (range !== "3m" && Date.now() - historyFetched > 60000))
  )
    loadHistory();

  // 每核
  const cores = o.perCore || [];
  const cc = $("#cores");
  cc.classList.toggle("heatmap", cores.length > 16);
  if (cc.children.length !== cores.length) {
    cc.innerHTML = cores
      .map(
        (_, i) =>
          `<div class="core"><span class="lb">c${i}</span><div class="bar s"><i></i></div><span class="pc"></span></div>`,
      )
      .join("");
  }
  cores.forEach((p, i) => {
    const row = cc.children[i],
      bar = row.querySelector("i");
    bar.style.width = Math.max(1, p).toFixed(1) + "%";
    setHeat(bar, p, "bg");
    row.title = `CPU ${i} · ${p.toFixed(1)}%`;
    row.style.setProperty("--usage", p / 100);
    row.querySelector(".pc").textContent = p.toFixed(0) + "%";
  });
  $("#coreCount").textContent =
    o.physical && o.physical !== o.cores
      ? tr("{physical} 物理核 / {cores} 线程", {
          physical: o.physical,
          cores: o.cores,
        })
      : tr("{count} 核", { count: o.cores });
  $("#temp").textContent = tr("温度 {value}", {
    value: o.temp > 0 ? o.temp.toFixed(0) + "°C" : "—",
  });
  $("#freq").textContent = tr("频率 {value}", {
    value: o.cpuMhz > 100 ? (o.cpuMhz / 1000).toFixed(2) + " GHz" : "—",
  });
  $("#procCount").textContent = tr("进程 {count}", {
    count: o.procCount || "—",
  });
}

function renderProcs(list) {
  cache.procs = list || [];
  const query = $("#procSearch").value.trim().toLowerCase();
  list = cache.procs
    .filter((p) =>
      [p.name, p.user, p.pid].some((x) =>
        String(x).toLowerCase().includes(query),
      ),
    )
    .sort((a, b) => (sortBy === "mem" ? b.rss - a.rss : b.cpu - a.cpu));
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  page = Math.min(page, pages - 1);
  const from = page * PAGE_SIZE,
    slice = list.slice(from, from + PAGE_SIZE);
  $("#pager").hidden = list.length <= PAGE_SIZE;
  $("#pageInfo").textContent = list.length
    ? tr("{from}–{to} / 共 {count} 个", {
        from: from + 1,
        to: from + slice.length,
        count: list.length,
      })
    : "";
  $("#pageNo").textContent = `${page + 1} / ${pages}`;
  $("#pagePrev").disabled = page === 0;
  $("#pageNext").disabled = page >= pages - 1;
  $("#procs").innerHTML =
    slice
      .map(
        (
          p,
        ) => `<div class="prow" data-pid="${p.pid}" role="button" tabindex="0" title="${esc(p.name)} · RSS ${bytes(p.rss)} · ${esc(stateLabel(p.status))}">
    <span class="pid">${p.pid}</span>
    <span class="nm">${esc(p.name)}</span>
    <span class="us">${esc(p.user)}</span>
    <span class="cp ${p.cpu > 20 ? "hot" : ""}">${p.cpu.toFixed(1)}%</span>
    <span class="mm">${p.memPct.toFixed(1)}%</span>
  </div>`,
      )
      .join("") || `<div class="empty">${tr("没有进程数据")}</div>`;
}

const ENABLED = new Set([
  "enabled",
  "enabled-runtime",
  "alias",
  "linked",
  "linked-runtime",
]);
const LOCKED = new Set([
  "static",
  "masked",
  "masked-runtime",
  "indirect",
  "generated",
  "transient",
]);

function renderServices(list) {
  cache.svcs = list;
  const el = $("#services");
  if (!list.length) {
    el.innerHTML = `<div class="empty">${tr("未配置系统服务。请在配置文件的 services 中添加服务名称。")}</div>`;
    renderLog();
    return;
  }
  el.innerHTML = list
    .map((s) => {
      const act = pending.get(s.name);
      const up = s.active === "active";
      const failed = s.active === "failed";
      const cls = act ? "busy" : up ? "running" : failed ? "failed" : "stopped";
      const pill = act
        ? {
            start: "启动中",
            stop: "停止中",
            restart: "重启中",
            enable: "处理中",
            disable: "处理中",
          }[act]
        : up
          ? "运行中"
          : failed
            ? "失败"
            : s.active === "unknown"
              ? "未知"
              : "已停止";
      const on = ENABLED.has(s.enabled),
        locked = LOCKED.has(s.enabled);
      const meta = up
        ? s.since
          ? tr("已运行 {duration}", { duration: durShort(s.since) })
          : "运行中"
        : failed
          ? s.sub || "failed"
          : s.since
            ? tr("已停止 {duration}", { duration: durShort(s.since) })
            : "未激活";
      return `<div class="svc ${cls}" data-name="${esc(s.name)}">
      <div class="row1">
        <div class="info">
          <div class="unit"><span class="dot"></span><b title="${esc(s.active)} / ${esc(s.sub)}">${esc(s.name)}</b></div>
          <span class="desc" title="${esc(s.description)}">${esc(s.description || s.sub || "")}</span>
        </div>
        <span class="pill">${tr(pill)}</span>
      </div>
      <div class="acts"><button data-logs="${esc(s.name)}">${tr("日志")}</button>
      ${
        role === "admin"
          ? `
        <button class="pri ${up ? "stop" : "start"}" data-act="${up ? "stop" : "start"}" ${act ? "disabled" : ""}>${act ? "…" : tr(up ? "停止" : "启动")}</button>
        <button data-act="restart" ${act ? "disabled" : ""}>${tr("重启")}</button>
        <button class="boot ${on ? "on" : ""}" data-act="${on ? "disable" : "enable"}" ${act || locked ? "disabled" : ""} title="${esc(s.enabled || "")}">${tr("自启 {state}", { state: locked ? esc(stateLabel(s.enabled)) : tr(on ? "开" : "关") })}</button>
        `
          : ""
      }<span class="meta">${esc(tr(meta))}</span>
      </div>
    </div>`;
    })
    .join("");
  renderLog();
}

function renderLog() {
  const list = cache.svcs;
  const running = list.filter((s) => s.active === "active").length;
  const head = list.length
    ? tr("{running}/{total} 个服务运行中", { running, total: list.length })
    : "";
  const activity = lastLog
    ? tr(
        lastLog.state === "pending"
          ? "{name}：{action}中…"
          : lastLog.state === "done"
            ? "{name}：{action}完成"
            : "{name}：{action}失败，{error}",
        {
          name: lastLog.name,
          action: tr(VERB[lastLog.action]),
          error: lastLog.error?.message,
        },
      )
    : "";
  $("#log").textContent = [head, activity].filter(Boolean).join(" · ") || "—";
}

// ---------- SSE with polling fallback ----------
async function tick() {
  if (inFlight || !authenticated || !live) return;
  inFlight = true;
  try {
    const [o, p, s, a, d] = await Promise.all([
      api("/api/overview"),
      api("/api/processes?limit=all"),
      api("/api/services"),
      api("/api/alerts"),
      api("/api/containers"),
    ]);
    if (!live || !authenticated) return;
    renderOverview(o);
    renderProcs(p);
    renderServices(s);
    renderAlerts(a);
    renderContainers(d);
    setOnline(true);
  } catch (e) {
    if (e.code !== "unauthorized") setOnline(false);
  } finally {
    inFlight = false;
  }
}
function schedule() {
  clearTimeout(tickTimer);
  if (
    !live ||
    document.hidden ||
    !authenticated ||
    stream?.readyState === EventSource.OPEN
  )
    return;
  tickTimer = setTimeout(async () => {
    await tick();
    schedule();
  }, 3000);
}
function connectStream() {
  if (!live || document.hidden || !authenticated) return;
  stream = new EventSource("/api/stream");
  lastStreamEvent = Date.now();
  stream.addEventListener("heartbeat", () => {
    lastStreamEvent = Date.now();
  });
  watchdog = setInterval(() => {
    if (Date.now() - lastStreamEvent > 6000) {
      stop();
      setOnline(false);
      connectStream();
      schedule();
    }
  }, 2000);
  const handlers = {
    overview: renderOverview,
    processes: renderProcs,
    services: renderServices,
    alerts: renderAlerts,
    containers: renderContainers,
  };
  for (const [event, handler] of Object.entries(handlers))
    stream.addEventListener(event, (e) => {
      if (live) {
        lastStreamEvent = Date.now();
        handler(JSON.parse(e.data));
        setOnline(true);
      }
    });
  stream.addEventListener("auth", () => showLogin());
  stream.onopen = () => {
    clearTimeout(tickTimer);
    setOnline(true);
  };
  stream.onerror = () => {
    setOnline(false);
    schedule();
  };
}
function start() {
  stop();
  if (!live || !authenticated) return;
  connectStream();
  tick();
}
function stop() {
  clearTimeout(tickTimer);
  clearInterval(watchdog);
  if (stream) {
    stream.close();
    stream = null;
  }
}

function renderClock() {
  $("#clock").textContent = new Date().toLocaleTimeString(I18n.locale(), {
    hour12: false,
  });
}
setInterval(renderClock, 1000);
renderClock();

// ---------- 交互 ----------
$("#live").addEventListener("click", () => {
  live = !live;
  $("#live").textContent = tr(live ? "● 实时刷新" : "○ 已暂停");
  live ? start() : stop();
});

document.querySelectorAll(".seg[data-sort]").forEach((b) =>
  b.addEventListener("click", () => {
    document
      .querySelectorAll(".seg[data-sort]")
      .forEach((x) => x.classList.toggle("on", x === b));
    sortBy = b.dataset.sort;
    page = 0;
    renderProcs(cache.procs);
  }),
);
$("#pagePrev").addEventListener("click", () => {
  page = Math.max(0, page - 1);
  renderProcs(cache.procs);
});
$("#pageNext").addEventListener("click", () => {
  page = page + 1;
  renderProcs(cache.procs);
});

// 主题切换：自动 → 深色 → 浅色 → 自动
const THEME_LABEL = {
  auto: "主题 自动",
  dark: "主题 深色",
  light: "主题 浅色",
};
function applyTheme(pref) {
  const root = document.documentElement;
  const resolved =
    pref === "auto"
      ? matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : pref;
  root.dataset.theme = resolved;
  root.dataset.themePref = pref;
  root.style.colorScheme = resolved;
  $("#theme").textContent = tr(THEME_LABEL[pref]);
  try {
    pref === "auto"
      ? localStorage.removeItem("servmon.theme")
      : localStorage.setItem("servmon.theme", pref);
  } catch {}
}
$("#theme").addEventListener("click", () => {
  const order = ["auto", "dark", "light"];
  applyTheme(
    order[
      (order.indexOf(document.documentElement.dataset.themePref || "auto") +
        1) %
        order.length
    ],
  );
});
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if ((document.documentElement.dataset.themePref || "auto") === "auto")
    applyTheme("auto");
});
$("#theme").textContent = tr(
  THEME_LABEL[document.documentElement.dataset.themePref || "auto"],
);

const VERB = {
  start: "启动",
  stop: "停止",
  restart: "重启",
  enable: "开启自启",
  disable: "关闭自启",
};
$("#services").addEventListener("click", async (e) => {
  const logs = e.target.closest("button[data-logs]");
  if (logs) {
    openLogs(logs.dataset.logs);
    return;
  }
  const btn = e.target.closest("button[data-act]");
  if (!btn || btn.disabled) return;
  const name = btn.closest(".svc").dataset.name,
    act = btn.dataset.act;
  if (
    act === "stop" &&
    !(await confirmAction(
      tr("确定{action}服务“{name}”？", { action: tr(VERB[act]), name }),
    ))
  )
    return;
  pending.set(name, act);
  renderServices(cache.svcs);
  setLog({ action: act, name, state: "pending" });
  try {
    const info = await api(`/api/services/${encodeURIComponent(name)}/${act}`, {
      method: "POST",
    });
    setLog({ action: act, name, state: "done" });
    toast(tr("{name}：{action}完成", { name, action: tr(VERB[act]) }));
    pending.delete(name);
    cache.svcs = cache.svcs.map((s) => (s.name === name ? info : s));
    renderServices(cache.svcs);
  } catch (err) {
    pending.delete(name);
    setLog({ action: act, name, state: "failed", error: err });
    toast(tr("操作失败：{error}", { error: err.message }), true, 5000);
    renderServices(cache.svcs);
  }
  tick();
});

function showLogin() {
  authenticated = false;
  stop();
  $("#login").classList.add("show");
  $("#tokenIn").focus();
}
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: $("#tokenIn").value }),
    });
    $("#tokenIn").value = "";
    await bootstrap();
  } catch (e) {
    toast(e.code === "unauthorized" ? tr("令牌不正确") : e.message, true);
  } finally {
    button.disabled = false;
  }
});

document.addEventListener("visibilitychange", () =>
  document.hidden ? stop() : authenticated ? live && start() : bootstrap(),
);

// ---------- History, alerts and diagnostics ----------
async function bootstrap() {
  clearTimeout(bootstrapTimer);
  try {
    const info = await api("/api/ping");
    role = info.role;
    persistent = info.persistent;
    authenticated = true;
    $("#login").classList.remove("show");
    $("#logout").hidden = !info.auth;
    $("#roleBadge").textContent =
      tr(role === "admin" ? "管理权限" : "只读模式") +
      (info.persistent ? "" : " · " + tr("内存模式"));
    start();
  } catch (e) {
    if (e.code !== "unauthorized") {
      authenticated = false;
      role = "view";
      try {
        const previous = JSON.parse(
          sessionStorage.getItem("servmon.last") || "null",
        );
        if (previous) renderOverview(previous);
      } catch {}
      setOnline(false);
      $("#badge").textContent = tr("已离线 · 显示最后一次数据");
      if (!document.hidden) bootstrapTimer = setTimeout(bootstrap, 3000);
    }
  }
}
$("#logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
    latestOverview = null;
    cache.procs = [];
    cache.svcs = [];
    sessionStorage.removeItem("servmon.last");
    location.reload();
  } catch (e) {
    toast(e.message, true);
  }
});
$("#procSearch").addEventListener("input", () => {
  page = 0;
  renderProcs(cache.procs);
});
$("#range").addEventListener("change", () => {
  range = $("#range").value;
  historyData = [];
  loadHistory(true);
});
$("#iface").addEventListener("change", () => {
  selectedIface = $("#iface").value;
  historyData = [];
  loadHistory(true);
});
async function loadHistory(force = false) {
  if (!authenticated) return;
  if (!force && Date.now() - historyFetched < 1200) return;
  historyFetched = Date.now();
  const id = ++historyRequest;
  const currentRange = range,
    currentIface = selectedIface;
  $("#historyStatus").textContent = tr("加载历史…");
  try {
    const h = await api(
      `/api/history?range=${range}&iface=${encodeURIComponent(selectedIface)}`,
    );
    if (
      id !== historyRequest ||
      range !== currentRange ||
      selectedIface !== currentIface
    )
      return;
    historyData =
      range === "3m"
        ? [
            ...h,
            ...historyData.filter((x) => !h.some((y) => y.t === x.t)),
          ].sort((a, b) => a.t - b.t)
        : h;
    $("#historyStatus").textContent = h.length
      ? tr("{count} 个采样点", { count: h.length })
      : tr("此时间范围暂无历史数据");
    if (latestOverview) renderOverview(latestOverview);
  } catch (e) {
    if (id === historyRequest) $("#historyStatus").textContent = e.message;
  }
}
function renderAxes(hist, max) {
  const fmt = (t) =>
    new Date(t * 1000).toLocaleString(I18n.locale(), {
      month: range === "7d" || range === "30d" ? "2-digit" : undefined,
      day: range === "7d" || range === "30d" ? "2-digit" : undefined,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  const times = hist.length
    ? `<span>${fmt(hist[0].t)}</span><span>${fmt(hist[hist.length - 1].t)}</span>`
    : `<span>${tr("暂无数据")}</span>`;
  $("#cpuAxis").innerHTML = times;
  $("#netAxis").innerHTML = times;
  $("#netScale").innerHTML =
    `<span>${rate(max)}</span><span>${rate(max / 2)}</span><span>0 B/s</span>`;
}
function chartSamples() {
  return range === "3m" && !selectedIface
    ? latestOverview?.history || []
    : historyData;
}
for (const selector of [".spark", ".chart"]) {
  const chart = $(selector);
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("class", "chartCursor");
  line.style.display = "none";
  chart.appendChild(line);
  chart.addEventListener("pointermove", (e) => {
    const hist = chartSamples();
    if (!hist.length) return;
    const box = chart.getBoundingClientRect(),
      ratio = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
    const target = hist[0].t + ratio * (hist[hist.length - 1].t - hist[0].t);
    let index = 0;
    for (let i = 1; i < hist.length; i++)
      if (Math.abs(hist[i].t - target) < Math.abs(hist[index].t - target))
        index = i;
    const s = hist[index],
      width = selector === ".spark" ? 300 : 600,
      height = selector === ".spark" ? 70 : 180;
    const x =
      hist.length > 1 && hist[hist.length - 1].t > hist[0].t
        ? ((s.t - hist[0].t) / (hist[hist.length - 1].t - hist[0].t)) * width
        : width;
    for (const [k, v] of Object.entries({ x1: x, x2: x, y1: 0, y2: height }))
      line.setAttribute(k, v);
    line.style.display = "";
    $("#chartHint").textContent =
      `${new Date(s.t * 1000).toLocaleString(I18n.locale())} · CPU ${s.cpu.toFixed(1)}% · ↓ ${rate(s.rx)} · ↑ ${rate(s.tx)}`;
    chart.setAttribute("aria-label", $("#chartHint").textContent);
  });
  chart.addEventListener("pointerleave", () => {
    line.style.display = "none";
  });
}
function renderAlerts(data) {
  alertData = data;
  $("#alertCount").textContent = data.active.length;
  $("#alertsButton").classList.toggle("alerting", data.active.length > 0);
  for (const [id, prefix] of [
    ["cpuCard", "cpu"],
    ["memTitle", "mem"],
    ["diskTitle", "disk"],
    ["services", "service"],
  ]) {
    const card = $("#" + id).closest(".card");
    card?.classList.toggle(
      "alerting",
      data.active.some(
        (x) =>
          x.rule === prefix ||
          x.rule.startsWith(prefix + ":") ||
          (prefix === "cpu" && x.rule === "load1"),
      ),
    );
  }
  if (drawerMode === "alerts") renderAlertDrawer();
}
let drawerMode = "",
  logsTimer = null,
  detailPID = null,
  detailCreated = null,
  drawerGeneration = 0;
function openDrawer(title, mode) {
  clearTimeout(logsTimer);
  drawerMode = mode;
  drawerGeneration++;
  $("#drawerTitle").textContent = title;
  $("#drawerContent").replaceChildren();
  if (!$("#drawer").open) $("#drawer").showModal();
}
function closeDrawer() {
  clearTimeout(logsTimer);
  drawerMode = "";
  drawerGeneration++;
  $("#drawer").close();
}
$("#closeDrawer").addEventListener("click", closeDrawer);
$("#drawer").addEventListener("close", () => {
  clearTimeout(logsTimer);
  drawerMode = "";
  drawerGeneration++;
});
function alertRule(rule) {
  if (rule === "cpu") return "CPU";
  if (rule === "mem") return tr("内存");
  if (rule === "load1") return tr("负载");
  const [type, ...parts] = rule.split(":");
  return type === "disk"
    ? tr("磁盘 {name}", { name: parts.join(":") })
    : type === "service"
      ? tr("服务 {name}", { name: parts.join(":") })
      : rule;
}
function elapsedDuration(seconds) {
  return seconds < 60
    ? tr("{count} 秒", { count: Math.max(0, Math.floor(seconds)) })
    : durShort(seconds);
}
function alertMessage(event) {
  const rule = alertRule(event.rule);
  return event.state === "resolved"
    ? tr("{rule}已恢复，异常持续 {duration}", {
        rule,
        duration: elapsedDuration(
          (new Date(event.at) - new Date(event.since)) / 1000,
        ),
      })
    : tr("{rule}：当前 {value}，阈值 {threshold}", {
        rule,
        value: Number(event.value).toFixed(2),
        threshold: Number(event.threshold).toFixed(2),
      });
}
function renderAlertDrawer() {
  const content = $("#drawerContent");
  const rows = (items) =>
    items
      .map(
        (e) =>
          `<div class="alertEntry"><strong class="${e.state === "firing" ? "heat-bad" : ""}">${esc(alertRule(e.rule))} · ${tr(e.state === "firing" ? "触发" : "已恢复")}</strong><p>${esc(alertMessage(e))}</p><small>${new Date(e.at).toLocaleString(I18n.locale())} · ${tr("开始于")} ${new Date(e.since).toLocaleString(I18n.locale())}</small></div>`,
      )
      .join("") || `<p class="empty">${tr("暂无告警")}</p>`;
  content.innerHTML = `<h3>${tr("活跃告警")}</h3>${rows(alertData.active)}<h3>${tr("最近 50 条记录")}</h3>${rows(alertData.history)}`;
}
$("#alertsButton").addEventListener("click", () => {
  openDrawer(tr("告警与通知"), "alerts");
  renderAlertDrawer();
});
async function openLogs(name) {
  openDrawer(tr("服务日志") + " · " + name, "logs");
  const gen = drawerGeneration;
  $("#drawerContent").innerHTML =
    `<label><input type="checkbox" id="followLogs" checked> ${tr("自动跟随")}</label><pre id="logOutput"></pre>`;
  const refresh = async () => {
    if (gen !== drawerGeneration) return;
    try {
      const result = await api(
        `/api/services/${encodeURIComponent(name)}/logs?n=200`,
      );
      if (gen !== drawerGeneration) return;
      $("#logOutput").textContent = result.logs || tr("暂无日志");
      $("#logOutput").scrollTop = $("#logOutput").scrollHeight;
    } catch (e) {
      if (gen === drawerGeneration) $("#logOutput").textContent = e.message;
    }
    if (gen === drawerGeneration && $("#followLogs")?.checked)
      logsTimer = setTimeout(refresh, 3000);
  };
  $("#followLogs").addEventListener("change", () => {
    clearTimeout(logsTimer);
    if ($("#followLogs").checked) refresh();
  });
  refresh();
}
async function openProcess(pid) {
  openDrawer(tr("进程详情") + " · " + pid, "process");
  const gen = drawerGeneration;
  $("#drawerContent").textContent = tr("加载中…");
  try {
    const p = await api("/api/processes/" + pid);
    if (gen !== drawerGeneration) return;
    detailPID = pid;
    detailCreated = p.created;
    const unavailable = new Set(p.unavailable || []);
    const val = (key, v) => (unavailable.has(key) ? tr("权限不足或不支持") : v);
    $("#drawerContent").innerHTML =
      `<dl><dt>${tr("命令行")}</dt><dd>${esc(val("command", p.command) || "—")}</dd><dt>${tr("工作目录")}</dt><dd>${esc(val("cwd", p.cwd) || "—")}</dd><dt>${tr("启动时间")}</dt><dd>${esc(val("created", new Date(p.created).toLocaleString(I18n.locale())))}</dd><dt>${tr("线程数")}</dt><dd>${esc(val("threads", p.threads))}</dd><dt>${tr("打开文件数")}</dt><dd>${esc(val("openFiles", p.openFiles))}</dd></dl>${role === "admin" ? `<div class="segs"><button class="live danger" data-signal="TERM">${tr("结束进程")} (TERM)</button><button class="live danger" data-signal="KILL">${tr("强制结束")} (KILL)</button></div>` : ""}`;
  } catch (e) {
    if (gen === drawerGeneration) $("#drawerContent").textContent = e.message;
  }
}
$("#procs").addEventListener("click", (e) => {
  const row = e.target.closest("[data-pid]");
  if (row) openProcess(row.dataset.pid);
});
$("#procs").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    const row = e.target.closest("[data-pid]");
    if (row) {
      e.preventDefault();
      openProcess(row.dataset.pid);
    }
  }
});
$("#drawerContent").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-signal]");
  if (!b) return;
  const pid = detailPID,
    created = detailCreated,
    sig = b.dataset.signal;
  if (
    !(await confirmAction(
      tr("确定结束进程 {pid}（{signal}）？", { pid, signal: sig }),
    ))
  )
    return;
  b.disabled = true;
  try {
    await api(`/api/processes/${pid}/kill?signal=${sig}&created=${created}`, {
      method: "POST",
    });
    toast(tr("操作完成"));
    closeDrawer();
    tick();
  } catch (e) {
    toast(e.message, true);
    b.disabled = false;
  }
});
function renderContainers(d) {
  containerData = d;
  $("#containers").hidden = !d.available;
  $("#dockerEmpty").hidden = Boolean(d.available);
  if (!d.available) {
    $("#dockerStatus").textContent = tr(
      "Docker 暂不可用，请确认 Docker 已启动且 servmon 有访问权限。",
    );
    return;
  }
  $("#containers").innerHTML =
    (d.containers || [])
      .map(
        (c) =>
          `<div class="containerRow"><div class="containerInfo"><b>${esc(c.name)}</b><small>${esc(c.image)} · ${esc(stateLabel(c.state))}</small></div><span>${c.statsAvailable ? c.cpu.toFixed(1) + "% · " + bytes(c.memory) : "—"}</span>${role === "admin" ? `<button class="live" data-container="${esc(c.id)}" data-action="${c.state === "running" ? "stop" : "start"}">${tr(c.state === "running" ? "停止" : "启动")}</button><button class="live" data-container="${esc(c.id)}" data-action="restart">${tr("重启")}</button>` : ""}</div>`,
      )
      .join("") || tr("没有容器");
}
$("#containers").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-container]");
  if (!b || b.disabled) return;
  const name =
    containerData?.containers?.find((c) => c.id === b.dataset.container)
      ?.name || b.dataset.container;
  if (
    !(await confirmAction(
      tr("确定{action}容器“{name}”？", {
        action: tr(VERB[b.dataset.action]),
        name,
      }),
    ))
  )
    return;
  b.disabled = true;
  try {
    await api(`/api/containers/${b.dataset.container}/${b.dataset.action}`, {
      method: "POST",
    });
    toast(tr("操作完成"));
  } catch (e) {
    toast(e.message, true);
  } finally {
    b.disabled = false;
  }
});

document.addEventListener("keydown", (e) => {
  if (
    e.ctrlKey ||
    e.metaKey ||
    e.altKey ||
    e.target.matches("input,textarea,select") ||
    document.querySelector("dialog[open]") ||
    $("#login").classList.contains("show")
  )
    return;
  if (e.key === "/") {
    e.preventDefault();
    showPanel("processes");
    $("#procSearch").focus();
  } else if (e.key.toLowerCase() === "p") $("#live").click();
  else if (e.key.toLowerCase() === "t") $("#theme").click();
});
function updateLanguage() {
  I18n.apply();
  $("#theme").textContent = tr(
    THEME_LABEL[document.documentElement.dataset.themePref || "auto"],
  );
  $("#live").textContent = tr(live ? "● 实时刷新" : "○ 已暂停");
  if (online !== null) setOnline(online);
  if (authenticated)
    $("#roleBadge").textContent =
      tr(role === "admin" ? "管理权限" : "只读模式") +
      (persistent ? "" : " · " + tr("内存模式"));
  if ($("#iface").options.length)
    $("#iface").options[0].textContent = tr("自动 / 总流量");
  if (latestOverview) renderOverview(latestOverview);
  renderProcs(cache.procs);
  renderServices(cache.svcs);
  renderAlerts(alertData);
  if (containerData) renderContainers(containerData);
  panelLayout.localize();
  renderClock();
  $("#toast").classList.remove("show");
}
const panelLayout = PanelLayout.init({
  confirm: confirmAction,
  tr,
  toast,
  showTab,
  onChange: syncHistoryControls,
});
for (const selector of ["#language", "#loginLanguage"])
  $(selector).addEventListener("click", () => {
    I18n.setLanguage(I18n.language === "en" ? "zh" : "en");
    updateLanguage();
  });
window.addEventListener("offline", () => {
  setOnline(false);
  $("#badge").textContent = tr("已离线 · 显示最后一次数据");
});
window.addEventListener("online", () => bootstrap());
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => {});
bootstrap();
