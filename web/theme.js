// 主题：localStorage 里的 servmon.theme 为 dark / light，缺省跟随系统；放在样式前面避免闪烁
(function () {
  const q = new URLSearchParams(location.search).get("theme");
  if (q === "dark" || q === "light") {
    try {
      localStorage.setItem("servmon.theme", q);
    } catch {}
  } else if (q === "auto") {
    try {
      localStorage.removeItem("servmon.theme");
    } catch {}
  }
  let t = "";
  try {
    t = localStorage.getItem("servmon.theme") || "";
  } catch {}
  const resolved =
    t ||
    (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePref = t || "auto";
  document.documentElement.style.colorScheme = resolved;
})();
