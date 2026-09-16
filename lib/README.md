# 旧通道（来自上游，未接入构建）

这里的代码是上游 `springrain1/get-to-obsidian` 的 Playwright + ZIP 导入通道：

- `get/auth.ts`：Playwright 打开浏览器登录得到大脑。
- `get/exporter.ts`：自动导出 HTML 压缩包。
- `get/importer.ts` / `get/core.ts`：解压、HTML → Markdown、生成 Moments / Canvas。
- `ui/*.ts`：旧的主界面 Modal 与设置面板。

**当前状态：不参与构建。** `tsconfig.json` 只包含 `main.ts` 与 `src/**`，`package.json` 也不再声明
`playwright` / `fs-extra` / `decompress` / `turndown` 等依赖，所以这些文件既不会被类型检查，也不会被打进 `main.js`。

不接入的原因：

1. 该通道要求最终用户在执行插件的目录里手动 `npm install` 并 `npx playwright install`，通过社区目录或 BRAT 安装的用户无法满足；
2. 它把 `decompress`（模块初始化即 `require('graceful-fs')` / `require('path')`）静态引入加载路径，会让插件在移动端启动即崩，与 `isDesktopOnly: false` 冲突；
3. 当前插件的同步、召回、推送全部走 OpenAPI，功能上不再需要它。

如需恢复：安装上述依赖，把 `lib/ui/main_ui.ts` 的入口接回 `main.ts`，并只在 `Platform.isDesktopApp` 为真时动态
`import()` 它（保持 CJS 懒加载形态，避免移动端在加载期执行 Node 代码）。
