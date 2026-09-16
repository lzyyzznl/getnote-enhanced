# Changelog

## [1.1.0]

把参考 CLI 里除「不建议搬」之外的能力全部接进插件：知识库写操作、博主/直播内容导入、OAuth 设备码授权、图片上传与 `link`/`img_text` 推送、标签与删除笔记。

### Added

- **知识库面板**（`src/ui/kb-panel.ts`，功能区图标 + 命令 `打开知识库面板`）：知识库范围四档（`DEFAULT` / `BOOKSPACE` / `CUSTOMER` / `TEAMSPACE`）、自有与订阅切换、笔记分页、目录树浏览、新建知识库。
- **知识库写操作**：新建 / 重命名 / 删除文件夹（`knowledge/directory/create|update|delete`）、把当前笔记加入知识库（`knowledge/note/batch-add`，单次上限 20 条由接口约定）、从知识库移出笔记（`knowledge/note/remove`）。目录删除前有确认弹窗。
- **内容导入轨道**（`src/sync/content.ts`）：博主内容（`blogger/contents` + `blogger/content/detail`）与直播（`lives` + `live/detail`）渲染成**只读** Markdown（前置字段 `uid` / `kind` / `topic` / `owner` / `published` / `source`，正文含 `## 摘要` 与 `## 原文`），落盘到 `<内容目录>/<知识库>/<博主|直播>/<标题>-<id>.md`。日志 `contentIndex` 记录 `路径|发布时间`，列表里时间没变的条目直接跳过、不拉详情；重命名过的文件按日志原路径就地更新，不会另建副本。批量导入（命令 `导入知识库内容（博主/直播）`）与面板内单条导入共用同一份日志，重复运行不产生重复文件。
- **博主 / 直播订阅**：`blogger/follow`、`live/follow`（面板内粘贴抖音博主链接或得到直播链接）。
- **OAuth 设备码授权**（`src/ui/oauth-login.ts`）：设置页「浏览器授权」，模态展示 `user_code` 与验证地址，按 `interval` 轮询，成功后自动写回 API Key 并刷新凭证。未填 `Client ID` 时直接报错并指引到开放平台建应用（参考 CLI 内置的 `cli_*` 属于其自有应用，不可借用）。
- **图片上传**：`image/upload_token` + OSS multipart（手拼 `Uint8Array`，字段顺序 `key → OSSAccessKeyId → policy → signature → callback → Content-Type → file`，不依赖 Node `Buffer`）。推送时把可写正文里内嵌的本地图片上传为 `image_urls`，笔记类型记为 `img_text`；上传失败即中止推送，不会静默丢图。
- **推送增强**：`note/save` 支持 `link`（前置字段 `url`）、`img_text`、`parent_id`（前置字段 `parent` 或 wiki 链接）、`client_request_id`（FNV-1a 幂等键，重试不会重复建笔记）；标题里的 `-<uid>` 后缀在推送前剥离。
- **笔记操作**：删除云端笔记（移入回收站）、标签管理（新增 / 删除，`tags/delete` 按 `tag_id`），以及分享时可选**排除音频**（`share_exclude_audio`）。
- **设置新增**：Web 页面地址（默认按 API 环境推导，用于生成笔记链接）、知识库范围、内容导入（启用 / 博主 / 直播 / 目标目录 / 立即导入）。
- **错误信息增强**：解析错误信封的 `field` / `constraint` / `expected_type` / `membership_url` 并拼进消息，参数错误能直接看到字段名，非会员错误能看到开通地址。
- **端到端脚本扩展**：知识库范围与订阅、目录创建→改名→删除、笔记加入/移出、博主与直播列表详情、单条内容导入幂等 + 批量两次验证日志跳过、`link`/`img_text` 推送断言（读回云端 `note_type`）、被删云端笔记的重建、标签删除、图片上传（token → OSS → `img_text` 笔记）、OAuth 设备码与未授权轮询状态，以及全部测试数据的清理。

### Fixed

- **OAuth 设备码请求地址**：此前把 API 地址里的 `/open/api/v1` 前缀剥掉再拼 `/oauth/device/code`，请求落到网站首页，返回 HTML 并抛出 `Unexpected token '<', "<!DOCTYPE "...`。现按参考 CLI 的规则补齐前缀（`…/open/api/v1/oauth/device/code`）。浏览器授权此前实际不可用。
- **图片笔记的异步任务**：云端对无法识别的图片（实测 1×1 测试图）会把任务标成 `failed`，但响应里已经带 `note_id` —— 笔记其实建好了。此前一律当成推送失败，用户会以为没推上去；现以 `note_id` 为准，只有任务失败且没有笔记 id 才算失败。
- **本地 `uid` 指向已删除的云端笔记**：此时 `note/update` 报 `无法找到笔记`（错误码是通用的 `10000 / invalid_request`），而用原幂等键重建又会被服务端回放成同一个已删除 id。现在改为用新幂等键重建，并把新 `uid` 写回本地文件，避免用户手动改前置字段。
- `blogger/content/detail` 的 `post_id_alias` 与 `post_title` 在视频类内容里返回**空字符串**。此前用 `??` 兜底会把空串当真值：详情 id 变成空串，后续请求报 `参数错误`，文件名也退化成博主名。现按参考 CLI 的取值规则改为「空串视为缺失」，标题回退 `post_name`（并压平换行），列表侧同样处理。
- 知识库同步的增量判断改用 `edit_time`：知识库内未变更的笔记不再拉详情。
- 笔记网页链接按 API 环境推导 base（dev 与生产不同），不再硬编码 `www.biji.com`。
- 端到端脚本中途失败时也会打印已通过的检查项（此前只剩一行异常，无法定位失败点）。

## [1.0.2]

### Added

- 设置项「启动时打开召回面板」（默认开）：Obsidian 启动后自动在右侧边栏打开语义召回面板。此前面板只能通过命令面板或左侧功能区图标唤起，装完容易误以为插件只有设置页。
- 召回面板的入口在 README 里列全：功能区两个图标（同步、召回）、命令面板 7 条命令、编辑器右键「以选中文本语义召回」。

## [1.0.1]

### Added

- 存量文件按 `uid` 认领：索引与推导路径都落空时，扫描 vault 内带 `uid` 前置字段的文件，命中即就地更新（保留本地正文）并改写索引。上游插件同步过的文件、被移动或改名的文件不再被当成新笔记而在推导路径重建副本。扫描优先用 `metadataCache` 前置字段做预筛，只对声明了 `uid` 的文件读原文；尚未被索引的文件（如刚启动）不会跳过，否则会漏认领并产生副本。
- 端到端脚本新增真实数据断言：`## 原文` / `## 转写` / `## 附件` 用账号里实际带 `web_page.content`、`audio.original`、`attachments` 的笔记渲染后断言；`## 时间线` / `## 会议待办` / `## 快捷笔记` 若账号内无可渲染样本，脚本显式报告「未对生产数据实测」而不是静默通过。
- 端到端脚本新增接管断言：预置一个路径不同、`uid` 相同的旧文件，同步后断言未新建副本、本地正文被保留、索引指向旧路径。

### Fixed

- 无变更检测在上游旧插件文件上的行为：此前只按索引与推导路径查找既有文件，路径不一致时会静默创建重复笔记。

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
