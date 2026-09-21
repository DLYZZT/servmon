# servmon 官网设计预览

独立的 React + Vite 官网，页面与样式均在 `website/` 内，与 Go 程序分开构建。

## 本地预览

```bash
cd website
npm ci
npm run dev -- --host 127.0.0.1 --port 4173
```

- 首页：`http://127.0.0.1:4173/#/`
- 下载：`http://127.0.0.1:4173/#/download`
- 文档：`http://127.0.0.1:4173/#/docs`

`npm run build` 输出静态前端到 `dist/`，可用 `npm run preview` 在本地查看构建结果。

## GitHub Pages 部署

官网使用独立工作流 `.github/workflows/deploy-website.yml`，不依赖 Go 程序的构建和 Release。

首次部署前，在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。

- 推送到 `main` 且修改了 `website/` 或部署工作流时，自动构建并部署。
- 也可以在 Actions 中打开 **Deploy website to GitHub Pages**，选择 `main` 分支手动运行。
- 工作流执行 `npm ci`、构建、上传 `website/dist/`，再部署到 `github-pages` 环境；其他分支不能通过手动运行发布。
- 使用 GitHub 自动提供的令牌，无需新增个人访问令牌或部署密钥。
- 构建路径来自 Pages 配置，支持项目子路径和自定义域名；页面内图片使用 Vite 的 `BASE_URL`。
- 默认发布地址为 `https://dlyzzt.github.io/servmon/`，实际地址以部署任务输出为准。

本地验证项目子路径：

```bash
npm run build -- --base /servmon/
npm run preview -- --base /servmon/ --port 4174
```

打开 `http://localhost:4174/servmon/`。部署流程的新增不会自行提交代码或触发远端发布。

参考：[GitHub Pages 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[Vite GitHub Pages 部署](https://vite.dev/guide/static-deploy.html#github-pages)。

## 设计与内容

- 延用应用的冷灰背景、蓝色强调色、细边框、小圆角、系统字体与等宽字体。
- 默认浅色，可切换深色并在本地保存选择。
- 品牌图标来自 `src/web/icon.svg`，监控截图来自 `assets/image.png`；截图是静态产品预览。
- 图标使用 Phosphor Icons。资源本地加载，无外部字体请求。
- 下载入口指向项目 GitHub Releases，不在页面写死版本号。
- 预览采用 hash 路由；正式上线前可再改为独立 URL 与静态页面输出，以优化搜索引擎收录。
