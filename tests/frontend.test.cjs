const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
function i18n(language = "en-US", saved = null) {
  const values = new Map(saved ? [["servmon.lang", saved]] : []);
  const context = vm.createContext({
    navigator: { language },
    localStorage: {
      getItem: (k) => values.get(k),
      setItem: (k, v) => values.set(k, v),
    },
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
      documentElement: {},
    },
  });
  vm.runInContext(read("src/web/i18n.js") + ";this.api=I18n", context);
  return context.api;
}
function layout() {
  const context = vm.createContext({});
  vm.runInContext(read("src/web/layout.js") + ";this.api=PanelLayout", context);
  return context.api;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
test("language preferences are validated and regional Chinese locales work", () => {
  assert.equal(i18n("zh-TW").language, "zh");
  assert.equal(i18n("en-GB", "zh").language, "zh");
  assert.equal(i18n("en-US", "broken").language, "en");
});
test("templates support plurals, literal user content and live language changes", () => {
  const t = i18n();
  assert.equal(t.t("{count} 核", { count: 1 }), "1 core");
  assert.equal(t.t("{count} 核", { count: 2 }), "2 cores");
  const name = "服务{action}<test>";
  assert.equal(
    t.t("确定{action}服务“{name}”？", { action: "Stop", name }),
    `Stop service “${name}”?`,
  );
  t.setLanguage("zh");
  assert.equal(t.t("{count} 核", { count: 2 }), "2 核");
  t.setLanguage("bad");
  assert.equal(t.language, "zh");
});
test("every static UI label, title, placeholder and panel/zone name has English copy", () => {
  const t = i18n(),
    html = read("src/web/index.html");
  const keys = [
    ...html.matchAll(
      /(?:data-i18n(?:-title|-label|-placeholder)?|data-panel-title|data-zone-title)="([^"]+)"/g,
    ),
  ].map((m) => m[1]);
  for (const key of keys) assert.doesNotMatch(t.t(key), /[\u3400-\u9fff]/, key);
});
test("localization touches only explicit bindings, never raw service names/logs", () => {
  const t = i18n();
  let query;
  const marked = { getAttribute: () => "系统服务", textContent: "系统服务" };
  const source = { textContent: "系统服务" };
  t.apply({
    querySelectorAll: (selector) => {
      query = selector;
      return selector === "[data-i18n]" ? [marked] : [];
    },
  });
  assert.equal(marked.textContent, "Services");
  assert.equal(source.textContent, "系统服务");
  assert.match(query, /data-i18n/);
  assert.doesNotMatch(
    read("src/web/app.js"),
    /MutationObserver|createTreeWalker/,
  );
});
test("all server error codes have a localized user message", () => {
  const t = i18n();
  const files = [
    "src/security.go",
    "src/server.go",
    "src/main.go",
    "src/docker.go",
  ];
  const codes = new Set(
    files.flatMap((file) =>
      [
        ...read(file).matchAll(
          /(?:codedError\("|writeAPIError\(w, [^,]+, ")([a-z_]+)"/g,
        ),
      ].map((m) => m[1]),
    ),
  );
  for (const code of codes) {
    const message = t.error(code, 400, 30);
    assert.doesNotMatch(message, /[\u3400-\u9fff]/);
    assert.notEqual(message, "Request failed (HTTP 400).", code);
  }
  assert.match(t.error("rate_limited", 429, 37), /37 seconds/);
  t.setLanguage("zh");
  assert.match(t.error("logs_unavailable", 503), /无法读取服务日志/);
  assert.equal(t.error("unknown_new_error", 502), "请求失败（HTTP 502）。");
});
test("panel IDs in the DOM and layout defaults stay in sync", () => {
  const ids = [
    ...read("src/web/index.html").matchAll(/data-panel="([^"]+)"/g),
  ].map((m) => m[1]);
  const defaults = Object.values(plain(layout().normalize(null))).flat();
  assert.deepEqual([...ids].sort(), defaults.sort());
  assert.equal(new Set(ids).size, 9);
});
test("layout accepts cross-page moves and empty pages without duplicating panels", () => {
  const l = layout(),
    original = plain(l.normalize(null));
  original.summary = original.summary.filter((x) => x !== "cpu");
  original.services.unshift("cpu");
  original["overview-extra"].push("processes");
  original.processes = [];
  const actual = plain(l.normalize(original));
  assert.deepEqual(actual, original);
  assert.equal(Object.values(actual).flat().length, 9);
});
test("corrupt layouts are repaired, with unknown IDs rejected and missing panels restored", () => {
  const l = layout();
  const result = plain(
    l.normalize({
      summary: ["services", "services", "not-a-panel", null, {}],
      charts: "not-an-array",
      docker: ["cpu"],
      rogue: ["network"],
    }),
  );
  assert.equal(result.summary[0], "services");
  assert.equal(result.docker[0], "cpu");
  const ids = Object.values(result).flat();
  assert.equal(ids.length, 9);
  assert.equal(new Set(ids).size, 9);
  assert.ok(!("rogue" in result));
});

test("legacy layout orders migrate and one damaged group does not erase the other", () => {
  const l = layout();
  const saved = {
    "servmon.layout.v1": "broken json",
    "servmon.order.0": '["0-2","0-0","0-1","0-3"]',
    "servmon.order.1": "bad json",
  };
  const state = plain(l.loadSaved((key) => saved[key]));
  assert.deepEqual(state.summary, ["disk", "cpu", "memory", "network"]);
  assert.deepEqual(state.charts, ["traffic", "cores"]);
  assert.equal(
    Object.values(
      plain(
        l.loadSaved(() => {
          throw Error("storage disabled");
        }),
      ),
    ).flat().length,
    9,
  );
});
test("all literal dynamic translations have English copy", () => {
  const t = i18n();
  for (const file of ["src/web/app.js", "src/web/layout.js"])
    for (const match of read(file).matchAll(/\btr\("([^"\n]+)"/g))
      assert.doesNotMatch(t.t(match[1]), /[\u3400-\u9fff]/, match[1]);
  assert.equal(t.error("__proto__", 500), "Request failed (HTTP 500).");
});
