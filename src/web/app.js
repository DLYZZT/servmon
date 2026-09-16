"use strict";
const $ = (s) => document.querySelector(s);
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
let lastLog = "";
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
  return (d ? d + " 天 " : "") + (h ? h + " 小时 " : "") + m + " 分";
}
function durShort(s) {
  s = Math.max(0, Math.floor(s));
  if (s < 60) return "刚刚";
  const d = Math.floor(s / 86400),
    h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
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
  $("#top").classList.toggle("off", !ok);
  $("#badge").textContent = ok ? "online" : tr("已离线 · 显示最后一次数据");
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

async function api(path, opts = {}) {
  const h = Object.assign({}, opts.headers || {});

  const r = await fetch(
    path,
    Object.assign({}, opts, {
      headers: h,
      signal: opts.signal || AbortSignal.timeout(12000),
    }),
  );
  if (r.status === 401) {
    try {
      sessionStorage.removeItem("servmon.last");
    } catch {}
    showLogin();
    throw new Error("unauthorized");
  }
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
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
        $("#historyStatus").textContent =
          `${historyData.length} ${tr("个采样点")}`;
    }
  }
  const hist = range === "3m" && !selectedIface ? o.history || [] : historyData;
  const n = Math.max(hist.length, 2);
  if (o.interval > 0) intervalMs = Math.max(500, o.interval * 1000);

  document.title = (o.host || "servmon") + " · servmon";
  $("#host").textContent = o.host || "—";
  $("#sys").textContent = [
    o.os,
    o.kernel ? "内核 " + o.kernel : "",
    "运行 " + dur(o.uptime),
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
  $("#cpuModel").textContent = o.cpuModel || o.cores + " 核";
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
    : "Swap 无";
  $("#cacheText").textContent = "缓存 " + bytes(o.memCached);

  // 磁盘
  const disks = o.disks || [];
  $("#diskCount").textContent = disks.length + " 个挂载点";
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
      .join("") || '<div class="empty">没有找到磁盘</div>';

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
  $("#netTotal").textContent =
    `累计 ${bytes(net.rxTotal)} ↓ · ${bytes(net.txTotal)} ↑`;
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
      ? `${o.physical} 物理核 / ${o.cores} 线程`
      : `${o.cores} 核`;
  $("#temp").textContent =
    "温度 " + (o.temp > 0 ? o.temp.toFixed(0) + "°C" : "—");
  $("#freq").textContent =
    "频率 " + (o.cpuMhz > 100 ? (o.cpuMhz / 1000).toFixed(2) + " GHz" : "—");
  $("#procCount").textContent = "进程 " + (o.procCount || "—");
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
    ? `${from + 1}–${from + slice.length} / 共 ${list.length} 个`
    : "";
  $("#pageNo").textContent = `${page + 1} / ${pages}`;
  $("#pagePrev").disabled = page === 0;
  $("#pageNext").disabled = page >= pages - 1;
  $("#procs").innerHTML =
    slice
      .map(
        (
          p,
        ) => `<div class="prow" data-pid="${p.pid}" role="button" tabindex="0" title="${esc(p.name)} · RSS ${bytes(p.rss)} · ${esc(p.status)}">
    <span class="pid">${p.pid}</span>
    <span class="nm">${esc(p.name)}</span>
    <span class="us">${esc(p.user)}</span>
    <span class="cp ${p.cpu > 20 ? "hot" : ""}">${p.cpu.toFixed(1)}%</span>
    <span class="mm">${p.memPct.toFixed(1)}%</span>
  </div>`,
      )
      .join("") || '<div class="empty">没有进程数据</div>';
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
    el.innerHTML =
      '<div class="empty">启动时用 <code>-services nginx,docker</code> 指定要管理的服务。</div>';
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
          ? "已运行 " + durShort(s.since)
          : "运行中"
        : failed
          ? s.sub || "failed"
          : s.since
            ? "停止 " + durShort(s.since)
            : "未激活";
      return `<div class="svc ${cls}" data-name="${esc(s.name)}">
      <div class="row1">
        <div class="info">
          <div class="unit"><span class="dot"></span><b title="${esc(s.active)} / ${esc(s.sub)}">${esc(s.name)}</b></div>
          <span class="desc" title="${esc(s.description)}">${esc(s.description || s.sub || "")}</span>
        </div>
        <span class="pill">${pill}</span>
      </div>
      <div class="acts"><button data-logs="${esc(s.name)}">${tr("日志")}</button>
      ${
        role === "admin"
          ? `
        <button class="pri ${up ? "stop" : "start"}" data-act="${up ? "stop" : "start"}" ${act ? "disabled" : ""}>${act ? "…" : up ? "停止" : "启动"}</button>
        <button data-act="restart" ${act ? "disabled" : ""}>重启</button>
        <button class="boot ${on ? "on" : ""}" data-act="${on ? "disable" : "enable"}" ${act || locked ? "disabled" : ""} title="${esc(s.enabled || "")}">自启 ${locked ? esc(s.enabled) : on ? "开" : "关"}</button>
        `
          : ""
      }<span class="meta">${esc(meta)}</span>
      </div>
    </div>`;
    })
    .join("");
  renderLog();
}

function renderLog() {
  const list = cache.svcs;
  const running = list.filter((s) => s.active === "active").length;
  const head = list.length ? `${running}/${list.length} 个服务运行中` : "";
  $("#log").textContent = [head, lastLog].filter(Boolean).join(" · ") || "—";
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
    if (e.message !== "unauthorized") setOnline(false);
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
  $("#clock").textContent = new Date().toLocaleTimeString("zh-CN", {
    hour12: false,
  });
}
setInterval(renderClock, 1000);
renderClock();

// ---------- 交互 ----------
$("#live").addEventListener("click", () => {
  live = !live;
  $("#live").textContent = live ? "● 实时刷新" : "○ 已暂停";
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
  $("#theme").textContent = THEME_LABEL[pref];
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
$("#theme").textContent =
  THEME_LABEL[document.documentElement.dataset.themePref || "auto"];

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
  if (act === "stop" && !confirm("确定停止 " + name + "？")) return;
  pending.set(name, act);
  renderServices(cache.svcs);
  setLog(`systemctl ${act} ${name} …`);
  try {
    const info = await api(`/api/services/${encodeURIComponent(name)}/${act}`, {
      method: "POST",
    });
    setLog(`systemctl ${act} ${name} — 完成`);
    toast(`${name} 已${VERB[act]}`);
    pending.delete(name);
    cache.svcs = cache.svcs.map((s) => (s.name === name ? info : s));
    renderServices(cache.svcs);
  } catch (err) {
    pending.delete(name);
    setLog(`systemctl ${act} ${name} — 失败：${err.message}`);
    toast("操作失败：" + err.message, true, 5000);
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
  const button = e.target.querySelector("button");
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
    toast(e.message === "unauthorized" ? tr("令牌不正确") : e.message, true);
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
    authenticated = true;
    $("#login").classList.remove("show");
    $("#logout").hidden = !info.auth;
    $("#roleBadge").textContent =
      tr(role === "admin" ? "管理权限" : "只读模式") +
      (info.persistent ? "" : " · " + tr("内存模式"));
    start();
  } catch (e) {
    if (e.message !== "unauthorized") {
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
      ? `${h.length} ${tr("个采样点")}`
      : tr("此时间范围暂无历史数据");
    if (latestOverview) renderOverview(latestOverview);
  } catch (e) {
    if (id === historyRequest) $("#historyStatus").textContent = e.message;
  }
}
function renderAxes(hist, max) {
  const fmt = (t) =>
    new Date(t * 1000).toLocaleString(lang === "en" ? "en-US" : "zh-CN", {
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
      `${new Date(s.t * 1000).toLocaleString()} · CPU ${s.cpu.toFixed(1)}% · ↓ ${rate(s.rx)} · ↑ ${rate(s.tx)}`;
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
function renderAlertDrawer() {
  const content = $("#drawerContent");
  const rows = (items) =>
    items
      .map(
        (e) =>
          `<div class="alertEntry"><strong class="${e.state === "firing" ? "heat-bad" : ""}">${esc(e.rule)} · ${tr(e.state === "firing" ? "触发" : "已恢复")}</strong><p>${esc(e.message)}</p><small>${new Date(e.at).toLocaleString()} · ${tr("开始于")} ${new Date(e.since).toLocaleString()}</small></div>`,
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
      `<dl><dt>${tr("命令行")}</dt><dd>${esc(val("command", p.command) || "—")}</dd><dt>${tr("工作目录")}</dt><dd>${esc(val("cwd", p.cwd) || "—")}</dd><dt>${tr("启动时间")}</dt><dd>${esc(val("created", new Date(p.created).toLocaleString()))}</dd><dt>${tr("线程数")}</dt><dd>${esc(val("threads", p.threads))}</dd><dt>${tr("打开文件数")}</dt><dd>${esc(val("openFiles", p.openFiles))}</dd></dl>${role === "admin" ? `<div class="segs"><button class="live danger" data-signal="TERM">${tr("结束进程")} (TERM)</button><button class="live danger" data-signal="KILL">${tr("强制结束")} (KILL)</button></div>` : ""}`;
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
  if (!confirm(`${tr("确定结束进程")} ${pid} (${sig})?`)) return;
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
  $("#containersPanel").hidden = !d.available;
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
          `<div class="containerRow"><div class="containerInfo"><b>${esc(c.name)}</b><small>${esc(c.image)} · ${esc(c.state)}</small></div><span>${c.statsAvailable ? c.cpu.toFixed(1) + "% · " + bytes(c.memory) : "—"}</span>${role === "admin" ? `<button class="live" data-container="${esc(c.id)}" data-action="${c.state === "running" ? "stop" : "start"}">${tr(c.state === "running" ? "停止" : "启动")}</button><button class="live" data-container="${esc(c.id)}" data-action="restart">${tr("重启")}</button>` : ""}</div>`,
      )
      .join("") || tr("没有容器");
}
$("#containers").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-container]");
  if (!b || b.disabled) return;
  if (!confirm(`${tr("确认容器操作")} ${b.dataset.action}?`)) return;
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

// ---------- Preferences, shortcuts and offline shell ----------
let lang = "zh";
try {
  lang =
    localStorage.getItem("servmon.lang") ||
    (navigator.language.startsWith("zh") ? "zh" : "en");
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
function tr(s) {
  return lang === "en" ? messages[s] || s : s;
}
function translateDynamic(raw) {
  if (lang !== "en") return raw;
  return raw.replace(/\d+–\d+ \/ 共 \d+ 个|[^\x00-\x7F]+/g, (part) => {
    if (messages[part]) return messages[part];
    return part.replace(
      /个服务运行中|个挂载点|物理核|已运行|自启|缓存|累计|温度|频率|进程|运行|内核|小时|分钟|线程|天|分|核|秒|共|个|开|关/g,
      (key) => messages[key] || key,
    );
  });
}
const originalText = new WeakMap();
function localize(root = document.body) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (["SCRIPT", "STYLE"].includes(node.parentElement?.tagName)) continue;
    const raw = node.textContent.trim();
    if (messages[raw]) {
      originalText.set(node, raw);
      node.textContent = node.textContent.replace(raw, tr(raw));
    } else if (originalText.has(node)) {
      node.textContent = node.textContent.replace(
        node.textContent.trim(),
        tr(originalText.get(node)),
      );
    } else if (
      lang === "en" &&
      !node.parentElement?.closest("#procs,#drawerContent,#containers")
    ) {
      const translated = translateDynamic(raw);
      if (translated !== raw)
        node.textContent = node.textContent.replace(raw, translated);
    }
  }
  for (const el of root.querySelectorAll("[placeholder]")) {
    const raw = el.dataset.originalPlaceholder || el.placeholder;
    el.dataset.originalPlaceholder = raw;
    el.placeholder = tr(raw);
  }
  document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
  $(".page-tabs").setAttribute(
    "aria-label",
    lang === "en" ? "Monitoring pages" : "监控页面",
  );
  $("#language").textContent = lang === "en" ? "中文" : "EN";
}
$("#language").addEventListener("click", () => {
  lang = lang === "en" ? "zh" : "en";
  try {
    localStorage.setItem("servmon.lang", lang);
  } catch {}
  location.reload();
});
let localizePending = false;
const translationObserver = new MutationObserver(() => {
  if (localizePending) return;
  localizePending = true;
  queueMicrotask(() => {
    translationObserver.disconnect();
    localize();
    localizePending = false;
    translationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
});
localize();
translationObserver.observe(document.body, {
  childList: true,
  subtree: true,
  characterData: true,
});
document.addEventListener("keydown", (e) => {
  if (
    e.ctrlKey ||
    e.metaKey ||
    e.altKey ||
    e.target.matches("input,textarea,select") ||
    $("#drawer").open ||
    $("#login").classList.contains("show")
  )
    return;
  if (e.key === "/") {
    e.preventDefault();
    showTab("processes");
    $("#procSearch").focus();
  } else if (e.key.toLowerCase() === "p") $("#live").click();
  else if (e.key.toLowerCase() === "t") $("#theme").click();
});
for (const [index, section] of [
  ...document.querySelectorAll("section.grid"),
].entries()) {
  section.dataset.group = index;
  const cards = [...section.children];
  cards.forEach((card, i) => {
    card.dataset.panel = `${index}-${i}`;
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "dragHandle";
    handle.textContent = "⠿";
    handle.title = "Drag to reorder · Alt + ← / →";
    handle.setAttribute("aria-label", handle.title);
    card.querySelector(".hd").prepend(handle);
    let dragging = false;
    const clearDrag = () => {
      dragging = false;
      card.classList.remove("dragging");
      section
        .querySelectorAll(".dropTarget")
        .forEach((x) => x.classList.remove("dropTarget"));
    };
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.focus();
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      card.classList.add("dragging");
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const target = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest(".card");
      for (const candidate of cards)
        candidate.classList.toggle(
          "dropTarget",
          candidate === target && candidate !== card,
        );
    });
    handle.addEventListener("pointerup", (e) => {
      if (!dragging) return;
      const target = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest(".card");
      clearDrag();
      if (target && target !== card && target.parentElement === section) {
        section.insertBefore(card, target);
        saveOrder();
      }
      if (handle.hasPointerCapture(e.pointerId))
        handle.releasePointerCapture(e.pointerId);
    });
    handle.addEventListener("pointercancel", clearDrag);
    handle.addEventListener("lostpointercapture", clearDrag);
    handle.addEventListener("keydown", (e) => {
      if (!e.altKey) return;
      if (e.key === "ArrowLeft" && card.previousElementSibling) {
        section.insertBefore(card, card.previousElementSibling);
        saveOrder();
      }
      if (e.key === "ArrowRight" && card.nextElementSibling) {
        section.insertBefore(card.nextElementSibling, card);
        saveOrder();
      }
    });
  });
  try {
    const saved = JSON.parse(
      localStorage.getItem("servmon.order." + index) || "[]",
    );
    for (const key of saved) {
      const card = cards.find((c) => c.dataset.panel === key);
      if (card) section.appendChild(card);
    }
  } catch {}
  function saveOrder() {
    try {
      localStorage.setItem(
        "servmon.order." + index,
        JSON.stringify([...section.children].map((x) => x.dataset.panel)),
      );
    } catch {}
  }
}
window.addEventListener("offline", () => {
  setOnline(false);
  $("#badge").textContent = tr("已离线 · 显示最后一次数据");
});
window.addEventListener("online", () => bootstrap());
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => {});
bootstrap();
