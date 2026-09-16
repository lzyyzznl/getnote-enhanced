# Changelog

## [1.0.0]

首个版本。基于 `springrain1/get-to-obsidian`（MIT）的脚手架与文件契约，重写 得到大脑/Get笔记 OpenAPI 通道。

### Added

- OpenAPI 通道：`Authorization` + `X-Client-ID` 双头鉴权，凭证只存本地 `data.json`。
- 增量下行同步：`note/list` 游标翻页（服务端固定 20 条/页），本地 `uid` 索引按 `updated_at` 判断是否需要重新拉取。
- 深度原文渲染（上游未提供）：链接原文、录音转写、时间线、会议待办、快捷笔记、附件索引，逐项开关；派生区块位于 `<!-- getnote:content:start/end -->` 可写区之后，只读展示。
- 附件下载：图片/音频/视频/文档分类开关，按 `note_id` 归档；未启用的类型保留描述文本而不是死链。
- 语义召回：侧栏视图（全局 / 指定知识库、Top-K 1–10）、编辑器划词右键、命令面板入口，命中本地文件时直接打开，否则一键同步。
- 知识库：知识库列表（自有/订阅）、知识库笔记分页拉取、目录结构浏览、按知识库同步。
- 推送：当前笔记新建或更新到云端（`plain_text`，异步任务自动轮询），`uid` 写回本地前置字段；生成公开分享链接（幂等）。
- 配额面板与熔断：读取/写入/写笔记/AI 对话四类配额，`quota_day` / `quota_month` / `not_member` 时停止调用并给出提示。
- 雪花 ID 安全：`parseJsonSafe` 在解析前把超出 `Number.MAX_SAFE_INTEGER` 的整数字面量转为字符串，避免 `JSON.parse` 静默取整（实测 `1921355588034527368` → `1921355588034527500`）。
- 移动端：`src/` 无任何 Node/Electron 依赖，`isDesktopOnly: false`。
- 端到端验证脚本 `scripts/smoke.mjs`：把 `src/` 打包到 Obsidian 运行时替身，在真实接口上跑通读链路与（可选）写链路。

### Changed

- 插件标识从上游的 `get-importer-sync` 改为 `getnote-enhanced`，与上游插件可并存安装。
- 构建链更新：esbuild 0.21（context/watch）、TypeScript 5.4、`strict` 开启、`types: []` 强制新代码不依赖 Node 全局；移除旧通道所需的 `playwright` / `fs-extra` / `decompress` 等依赖（旧通道源码保留在 `lib/`，未接入构建）。

### Removed

- 旧 ZIP/Playwright 导入通道不再接入插件加载路径（它要求用户手动安装 Playwright，官方发布版同样无法自带该能力）。源码与 git 历史保留，需要者可按 `lib/README.md` 恢复。
