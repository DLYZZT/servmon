"use strict";
const PanelLayout = (() => {
  const STORAGE = "servmon.layout.v1";
  const DEFAULT = {
    summary: ["cpu", "memory", "disk", "network"],
    charts: ["traffic", "cores"],
    "overview-extra": [],
    processes: ["processes"],
    docker: ["containers"],
    services: ["services"],
  };
  // Treat persisted layout as data: ignore unknown IDs, repair missing panels,
  // and keep each panel exactly once, even after an older or corrupt save.
  function normalize(saved) {
    const result = {},
      seen = new Set();
    const known = new Set(Object.values(DEFAULT).flat());
    for (const zone of Object.keys(DEFAULT)) {
      result[zone] = [];
      for (const id of Array.isArray(saved?.[zone]) ? saved[zone] : []) {
        if (known.has(id) && !seen.has(id)) {
          result[zone].push(id);
          seen.add(id);
        }
      }
    }
    for (const [zone, ids] of Object.entries(DEFAULT)) {
      for (const id of ids)
        if (!seen.has(id)) {
          result[zone].push(id);
          seen.add(id);
        }
    }
    return result;
  }
  function loadSaved(getItem) {
    const read = (key) => {
      try {
        return JSON.parse(getItem(key) || "null");
      } catch {
        return null;
      }
    };
    const saved = read(STORAGE);
    if (saved?.version === 1 && saved.zones && typeof saved.zones === "object")
      return normalize(saved.zones);
    const legacy = normalize(null);
    for (const [index, zone] of [
      [0, "summary"],
      [1, "charts"],
    ]) {
      const old = read("servmon.order." + index);
      if (Array.isArray(old))
        legacy[zone] = old
          .map((id) => {
            const match = new RegExp(`^${index}-(\\d+)$`).exec(String(id));
            return match ? DEFAULT[zone][Number(match[1])] : null;
          })
          .filter(Boolean);
    }
    return normalize(legacy);
  }
  function init({ tr, toast, showTab, onChange, confirm }) {
    const zones = new Map(
      [...document.querySelectorAll(".layout-zone")].map((z) => [
        z.dataset.zone,
        z,
      ]),
    );
    const panels = new Map(
      [...document.querySelectorAll("[data-panel]")].map((p) => [
        p.dataset.panel,
        p,
      ]),
    );
    const title = (p) => tr(p.dataset.panelTitle);
    const zoneTitle = (z) => tr(z.dataset.zoneTitle);
    const preferred = {
      overview: "overview-extra",
      processes: "processes",
      docker: "docker",
      services: "services",
    };
    const announcement = document.createElement("div");
    announcement.className = "sr-only";
    announcement.setAttribute("role", "status");
    document.body.appendChild(announcement);
    for (const zone of zones.values()) {
      const empty = document.createElement("p");
      empty.className = "zone-empty";
      empty.dataset.i18n = "将面板拖到这里，或使用其它面板的“移动到…”";
      zone.appendChild(empty);
    }
    let drag = null,
      hoverTimer = null,
      frame = 0,
      movePanelID = null;
    const dialog = document.createElement("dialog");
    dialog.id = "movePanelDialog";
    dialog.innerHTML = `<form method="dialog"><h2 id="movePanelTitle"></h2><label><span data-i18n="目标位置"></span><select id="moveDestination"></select></label><label><span data-i18n="面板位置"></span><select id="movePosition"><option value="last" data-i18n="最后"></option><option value="first" data-i18n="最前"></option></select></label><div class="dialog-actions"><button type="button" class="live" id="cancelMove" data-i18n="取消"></button><button type="submit" class="live" data-i18n="移动"></button></div></form>`;
    dialog.setAttribute("aria-labelledby", "movePanelTitle");
    document.body.appendChild(dialog);
    const destination = dialog.querySelector("#moveDestination");
    for (const [id] of zones) {
      const option = document.createElement("option");
      option.value = id;
      destination.appendChild(option);
    }
    function localize() {
      I18n.apply(dialog);
      for (const option of destination.options)
        option.textContent = zoneTitle(zones.get(option.value));
      for (const panel of panels.values()) {
        const handle = panel.querySelector(".dragHandle"),
          move = panel.querySelector(".movePanel");
        handle.title = tr("拖动“{panel}”以移动；Alt + 方向键调整位置", {
          panel: title(panel),
        });
        handle.setAttribute("aria-label", handle.title);
        move.title = tr("移动到…") + " · " + title(panel);
        move.setAttribute("aria-label", move.title);
        move.textContent = "⋯";
      }
      for (const zone of zones.values()) {
        zone.setAttribute("aria-label", zoneTitle(zone));
        I18n.apply(zone.querySelector(".zone-empty"));
      }
      if (movePanelID)
        dialog.querySelector("h2").textContent = tr("移动“{panel}”", {
          panel: title(panels.get(movePanelID)),
        });
    }
    const contents = (zone) =>
      [...zone.children].filter((x) => x.matches("[data-panel]"));
    function refresh() {
      for (const zone of zones.values())
        zone.classList.toggle("is-empty", contents(zone).length === 0);
      onChange();
    }
    function save() {
      const state = Object.fromEntries(
        [...zones].map(([id, z]) => [
          id,
          contents(z).map((p) => p.dataset.panel),
        ]),
      );
      try {
        localStorage.setItem(
          STORAGE,
          JSON.stringify({ version: 1, zones: state }),
        );
      } catch {
        toast(tr("无法保存布局，刷新后可能恢复默认。"), true);
      }
    }
    function apply(state) {
      for (const [id, list] of Object.entries(normalize(state)))
        for (const panel of list)
          zones
            .get(id)
            .insertBefore(
              panels.get(panel),
              zones.get(id).querySelector(".zone-empty"),
            );
      refresh();
    }
    function move(panel, zone, before = null) {
      if (!panel || !zone || before === panel) return;
      zone.insertBefore(panel, before || zone.querySelector(".zone-empty"));
      refresh();
      save();
      const message = tr("已将“{panel}”移至{destination}", {
        panel: title(panel),
        destination: zoneTitle(zone),
      });
      announcement.textContent = message;
      return message;
    }
    function openMove(panel) {
      movePanelID = panel.dataset.panel;
      destination.value = panel.parentElement.dataset.zone;
      dialog.querySelector("#movePosition").value = "last";
      localize();
      dialog.showModal();
      destination.focus();
    }
    dialog
      .querySelector("#cancelMove")
      .addEventListener("click", () => dialog.close());
    dialog.addEventListener("submit", (e) => {
      e.preventDefault();
      const panel = panels.get(movePanelID),
        zone = zones.get(destination.value);
      const before =
        dialog.querySelector("#movePosition").value === "first"
          ? contents(zone).find((p) => p !== panel)
          : null;
      const message = move(panel, zone, before);
      dialog.close();
      showTab(zone.closest(".tab-panel").dataset.page);
      panel.querySelector(".movePanel").focus();
      if (message) toast(message);
    });
    dialog.addEventListener("close", () => {
      movePanelID = null;
    });
    function clearTargets() {
      document
        .querySelectorAll(".drop-zone,.drop-before,.drop-after,.drop-tab")
        .forEach((n) =>
          n.classList.remove(
            "drop-zone",
            "drop-before",
            "drop-after",
            "drop-tab",
          ),
        );
    }
    function dropAt(x, y) {
      const element = document.elementFromPoint(x, y);
      const tab = element?.closest(".page-tab");
      if (tab)
        return {
          zone: zones.get(preferred[tab.dataset.tab]),
          before: null,
          tab,
        };
      const zone = element?.closest(".layout-zone");
      if (!zone) return null;
      const target = element.closest("[data-panel]");
      if (target === drag.panel) return { zone, before: drag.panel };
      if (!target || target.parentElement !== zone)
        return { zone, before: null };
      const rect = target.getBoundingClientRect();
      const horizontal = rect.width < zone.getBoundingClientRect().width * 0.8;
      const after = horizontal
        ? x > rect.left + rect.width / 2
        : y > rect.top + rect.height / 2;
      const siblings = contents(zone).filter((p) => p !== drag.panel);
      return {
        zone,
        target,
        after,
        before: after ? siblings[siblings.indexOf(target) + 1] || null : target,
      };
    }
    function updateTarget() {
      if (!drag?.active) return;
      clearTargets();
      const target = dropAt(drag.x, drag.y);
      drag.target = target;
      const tab = target?.tab;
      if (tab !== drag.hoverTab) {
        clearTimeout(hoverTimer);
        drag.hoverTab = tab;
        if (tab)
          hoverTimer = setTimeout(() => {
            if (drag?.active && drag.hoverTab === tab) {
              showTab(tab.dataset.tab);
              refresh();
            }
          }, 450);
      }
      if (target) {
        if (tab) tab.classList.add("drop-tab");
        else if (target.target)
          target.target.classList.add(
            target.after ? "drop-after" : "drop-before",
          );
        else target.zone.classList.add("drop-zone");
        drag.ghost.textContent = target.target
          ? tr(target.after ? "放到“{panel}”之后" : "放到“{panel}”之前", {
              panel: title(target.target),
            })
          : tr("放到{destination}", { destination: zoneTitle(target.zone) });
      } else drag.ghost.textContent = title(drag.panel);
      drag.ghost.style.left =
        Math.min(drag.x + 12, window.innerWidth - drag.ghost.offsetWidth - 8) +
        "px";
      drag.ghost.style.top =
        Math.min(
          drag.y + 12,
          window.innerHeight - drag.ghost.offsetHeight - 8,
        ) + "px";
    }
    function autoScroll() {
      if (!drag?.active) return;
      const speed =
        drag.y < 60 ? -12 : drag.y > window.innerHeight - 60 ? 12 : 0;
      if (speed) {
        window.scrollBy(0, speed);
        updateTarget();
      }
      frame = requestAnimationFrame(autoScroll);
    }
    function finish(cancelled = false) {
      if (!drag) return;
      const current = drag;
      drag = null;
      clearTimeout(hoverTimer);
      cancelAnimationFrame(frame);
      clearTargets();
      document.body.classList.remove("layout-dragging");
      current.panel.classList.remove("dragging");
      current.ghost?.remove();
      if (document.body.hasPointerCapture(current.pointerID))
        document.body.releasePointerCapture(current.pointerID);
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("keydown", escapeDrag);
      if (!current.active) return;
      if (!cancelled && current.target) {
        const { zone, before } = current.target;
        move(current.panel, zone, before);
        showTab(zone.closest(".tab-panel").dataset.page);
      } else showTab(current.origin);
      current.panel.querySelector(".dragHandle").focus();
      refresh();
    }
    function pointerMove(e) {
      if (!drag || e.pointerId !== drag.pointerID) return;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (
        !drag.active &&
        Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 5
      ) {
        drag.active = true;
        document.body.classList.add("layout-dragging");
        drag.panel.classList.add("dragging");
        const ghost = document.createElement("div");
        ghost.className = "drag-ghost";
        ghost.setAttribute("aria-hidden", "true");
        ghost.textContent = title(drag.panel);
        document.body.appendChild(ghost);
        drag.ghost = ghost;
        frame = requestAnimationFrame(autoScroll);
      }
      updateTarget();
    }
    function pointerUp(e) {
      if (drag && e.pointerId === drag.pointerID) {
        if (drag.active) {
          drag.x = e.clientX;
          drag.y = e.clientY;
          updateTarget();
        }
        finish();
      }
    }
    function pointerCancel() {
      finish(true);
    }
    function escapeDrag(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(true);
      }
    }
    for (const panel of panels.values()) {
      const heading = panel.querySelector(".hd");
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "dragHandle";
      handle.textContent = "⠿";
      heading.prepend(handle);
      const moveButton = document.createElement("button");
      moveButton.type = "button";
      moveButton.className = "seg movePanel";
      heading.appendChild(moveButton);
      moveButton.addEventListener("click", () => openMove(panel));
      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || drag) return;
        e.preventDefault();
        handle.focus();
        drag = {
          panel,
          pointerID: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          x: e.clientX,
          y: e.clientY,
          active: false,
          origin: panel.closest(".tab-panel").dataset.page,
        };
        document.body.setPointerCapture(e.pointerId);
        window.addEventListener("pointermove", pointerMove);
        window.addEventListener("pointerup", pointerUp);
        window.addEventListener("pointercancel", pointerCancel);
        window.addEventListener("keydown", escapeDrag);
      });
      handle.addEventListener("keydown", (e) => {
        if (
          !e.altKey ||
          !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
        )
          return;
        e.preventDefault();
        const zone = panel.parentElement,
          list = contents(zone),
          index = list.indexOf(panel);
        const backward = e.key === "ArrowLeft" || e.key === "ArrowUp";
        if (backward && index > 0) move(panel, zone, list[index - 1]);
        else if (!backward && index < list.length - 1)
          move(panel, zone, list[index + 2] || null);
        handle.focus();
      });
    }
    document
      .querySelector("#resetLayout")
      .addEventListener("click", async () => {
        if (!(await confirm(tr("确定恢复默认布局？")))) return;
        finish(true);
        apply(DEFAULT);
        save();
        toast(tr("布局已恢复"));
      });
    apply(loadSaved((key) => localStorage.getItem(key)));
    localize();
    return { localize };
  }
  return { init, normalize, loadSaved };
})();
