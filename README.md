# GetNote Enhanced

把 **得到大脑（Get笔记）** 的笔记同步进 Obsidian，并补上上游插件没有做透的部分：语义召回、深度原文（录音转写 / 时间线 / 会议待办 / 链接原文 / 附件索引）、以及把 Obsidian 笔记推回云端。

本仓库 fork 自 [`springrain1/get-to-obsidian`](https://github.com/springrain1/get-to-obsidian)（MIT），保留其 git 历史，沿用它已建立的**文件契约**（`uid` 前置字段、`<!-- getnote:content:start/end -->` 可写区标记、目录命名习惯）。存量文件的接管方式是**按 `uid` 认领**：同步时先查本地索引、再查本插件推导出的路径，都落空时扫描 vault 中带 `uid` 前置字段的文件，命中即改写索引并就地更新，不会在推导路径另建副本；被认领文件的本地正文同样按「云端更新则覆盖、否则保留」处理。OpenAPI 通道代码为本仓库实现（上游仓库只公开了旧的 Playwright/ZIP 通道源码，API 通道未公开）。

---

## 功能

| 能力 | 说明 |
|---|---|
| 增量下行同步 | `note/list` 游标翻页 + 本地 `uid` 索引，未变更的笔记不重复拉取详情 |
| 深度原文 | 链接笔记原文（`web_page.content`）、录音转写（`audio.original`）、时间线（`timeline`）、会议待办（`meeting_todos`）、快捷笔记、附件索引、AI 摘要，逐项可开关 |
| 附件下载 | 图片 / 音频 / 视频 / 文档分类开关，按 `note_id` 归档到独立目录，未勾选的类型只保留描述文本 |
| 语义召回 | 侧栏视图（全局 / 指定知识库、Top-K 1–10）、编辑器划词右键召回、命令面板入口；本地已有则直接打开，仅有云端则一键同步 |
| 知识库面板 | 范围四档（默认 / 书房 / 客户 / 团队）、自有与订阅切换、笔记分页、目录树浏览与写入（新建 / 重命名 / 删除文件夹）、把当前笔记加入或移出知识库、新建知识库 |
| 内容导入 | 博主内容与直播导入为**只读** Markdown（摘要 + 原文），按 `路径\|发布时间` 日志跳过未变更条目；批量与单条导入共用日志，不产生重复文件；可订阅博主 / 直播 |
| 推送回云端 | 当前笔记新建或更新到云端（写入 `uid` 回本地），自动识别 `plain_text` / `link` / `img_text`（正文内嵌的本地图片先上传），带幂等键避免重试重复建笔记；支持生成公开分享链接（可选排除音频） |
| 笔记操作 | 删除云端笔记（移入回收站）、标签管理（新增 / 删除） |
| OAuth 授权 | 设置页「浏览器授权」：设备码流程，浏览器里点一下即可取回 API Key，不必手抄 |
| 配额面板 | 读取 / 写入 / 写笔记 / AI 对话四类配额的今日与月度用量，含用尽熔断 |
| 移动端 | 只用 `requestUrl` 与 Vault API，不依赖 Node/Electron，手机端可用 |

**不包含**（有意为之，不是半成品）：双向冲突三栏合并 UI、Web 私有 API 通道、旧 ZIP/Playwright 导入通道（后者源码保留在 `lib/`，未接入加载路径，见 `lib/README.md`）。

## 前置条件

- **得到大脑会员**：OpenAPI 仅对会员开放，非会员会收到错误码 `10201`。
- **API 凭证**：在 [得到大脑开放平台](https://www.biji.com/openapi) 创建应用后获得 `Client ID`（`cli_xxx`）与 `API Key`（`gk_live_xxx`）。API Key 只展示一次，请立即保存。
- Obsidian 1.5.0 或更高版本。

## 安装

### 手动安装

把 `main.js`、`manifest.json`、`styles.css` 放入：

```text
<你的 vault>/.obsidian/plugins/getnote-enhanced/
```

重启 Obsidian，然后在「设置 → 第三方插件」启用 **GetNote Enhanced**。

### BRAT

安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 后添加本仓库地址，BRAT 会自动更新。

### 从源码构建

```bash
npm install
npm run build        # 产出 main.js
```

## 使用

1. 打开「设置 → GetNote Enhanced → 凭证」，填入 `API Key` 与 `Client ID`，点「测试连接」。
2. 点左侧功能区笔记本图标或运行命令 `同步最新笔记`。
3. 搜索：点功能区放大镜图标打开「语义召回」侧栏；在编辑器里选中文字右键可直接召回。

常用命令：

```text
同步最新笔记
同步指定知识库
导入知识库内容（博主/直播）
打开语义召回
打开知识库面板
以选中文本语义召回
推送当前笔记到得到大脑
生成当前笔记的分享链接
删除云端笔记（移入回收站）
管理当前笔记的标签
查看接口配额
```

功能区图标三个：同步（笔记本）、语义召回（放大镜）、知识库面板（目录树）。删除与标签管理也在文件列表右键菜单里。

## 写入的文件长什么样

```markdown
---
uid: "1921355588034527368"
title: 新婚贺礼红包记录汇总
note_type: img_text
created: 2026-09-14 21:12:03
modified: 2026-09-15 00:03:53
tags:
  - 图片笔记
  - 新婚红包记录
source: https://www.biji.com/note/1921355588034527368
---

<!-- getnote:content:start -->
（云端正文 / AI 摘要，推送时只有这一段会被写回云端）
<!-- getnote:content:end -->

## 原文
## 转写
## 时间线
## 会议待办
## 快捷笔记
## 附件
## 子笔记
```

只有标题、正文、标签会被写回云端；`## ` 派生区块是本地只读展示，不会污染云端正文。

### 导入的博主内容 / 直播

```markdown
---
uid: "zeEGj3m1zlJknN8A"
kind: blogger
topic: 技术栈
owner: AI超元域
published: 2026-08-25 20:02:30
source: https://www.iesdouyin.com/share/video/7677938425999150346/…
---

> 只读导入（readonly: true）：本文件由知识库内容同步生成，修改不会回传得到大脑。

## 摘要
## 原文
```

导入文件按 `<内容目录>/<知识库>/<博主|直播>/<标题>-<id>.md` 落盘，**永不回传**（接口没有内容更新通道）。更新时间记录在设置里的 `contentIndex` 日志（`路径|发布时间`），条目未变更时不重复请求详情，重命名过的文件按日志里的原路径就地更新。

## 设置项

- **凭证**：API Key、Client ID、API 地址（默认生产环境）、笔记网页地址（留空按 API 环境推导）、测试连接、浏览器授权（OAuth 设备码，浏览器里点一下即可取回 API Key）。
- **同步**：目标文件夹、目录布局（`flat` / 按类型 / 按日期）、启动时同步、定时同步（分钟，0 为关闭）、立即同步。
- **附件**：附件目录、图片/音频/视频/文档四类开关。
- **深度内容**：原文、转写、时间线、会议待办、快捷笔记、附件、AI 摘要七类开关。
- **推送**：是否允许推送、限制目录、云端内链转本地 `[[链接]]`、推送当前笔记。
- **召回**：启动时打开召回面板、Top-K、默认知识库。
- **知识库**：默认范围（默认 / 书房 / 客户 / 团队）。
- **内容导入**：总开关、博主内容、直播内容、导入目录、立即导入（可选知识库）。

## 隐私与网络

- 网络请求只发往两处：`openapi.biji.com`（OpenAPI）与笔记附件所在的 CDN/OSS 地址（仅在你启用了对应附件类型时）。
- `API Key` 与 `Client ID` 只保存在本 vault 的 `.obsidian/plugins/getnote-enhanced/data.json`，不会上传，也不会写入日志或笔记内容。
- 插件不包含任何遥测、广告或自动更新行为；升级由你自行决定。

## 与上游插件的差异

- 上游 `get-importer-sync`（Dedao Brain Importer）发布的 OpenAPI / 语义召回 / 双向同步能力**没有公开源码**（其仓库只跟踪旧通道），因此本仓库无法在其实现上做增量修改；本仓库重写了 API 通道，并按上游的文件契约保持兼容。
- 本仓库补上了上游缺少的深度原文渲染（转写 / 时间线 / 会议待办 / 原文 / 附件索引）。
- 上游依赖 Playwright 等 Node 依赖并声明 `isDesktopOnly: false`；本仓库新通道零 Node 依赖，移动端声明名副其实。

> 若要提交到 Obsidian 官方社区目录：Obsidian 的 [开发者政策](https://docs.obsidian.md/community-directory/developer-policies) 规定 fork 未经原作者公开书面许可不得上架。本仓库是独立实现，但沿用了上游契约与脚手架，建议先取得原作者同意或先以 BRAT 分发。

## 开发与验证

```bash
npm install
npm run build                        # tsc 类型检查 + esbuild 打包
node scripts/smoke.mjs               # 真实接口端到端验证（见下）
```

`scripts/smoke.mjs` 会把 `src/` 打包到 `obsidian` 运行时替身（`scripts/obsidian-stub.mjs`）上，在临时 vault 中跑完整链路：配额 → 列表 → 详情 → 渲染 → 拉取（含附件）→ 二次增量 → 召回 → 知识库目录 → 博主/直播详情 → 内容导入（单条幂等 + 批量两次验证日志跳过）。写入链路默认跳过，需显式开启：

```bash
export GETNOTE_API_KEY=gk_live_xxx
export GETNOTE_CLIENT_ID=cli_xxx
export GETNOTE_SMOKE_VAULT=/tmp/getnote-smoke-vault
node scripts/smoke.mjs                      # 只读链路（含内容导入的只读部分）
# 写入链路：目录创建→改名→删除、笔记创建→更新→标签→分享→删除、笔记加入/移出知识库
GETNOTE_SMOKE_WRITE=1 GETNOTE_SMOKE_WRITE_DELETE=1 node scripts/smoke.mjs
# 额外验证图片上传（token → OSS multipart → img_text 笔记）
GETNOTE_SMOKE_IMAGE=/path/to/probe.png GETNOTE_SMOKE_WRITE=1 GETNOTE_SMOKE_WRITE_DELETE=1 node scripts/smoke.mjs
```

写入链路会自造唯一名称并自行清理（目录删除、笔记移入回收站、标签只删自己加的那个），跑完账号状态与运行前一致。

## 归属与许可

MIT。基于 [`springrain1/get-to-obsidian`](https://github.com/springrain1/get-to-obsidian)（原作者 Jialu Y 及其上游）的工作，保留其许可与历史；API 通道、深度内容渲染与召回界面为本仓库新增实现。
