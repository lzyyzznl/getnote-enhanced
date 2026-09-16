import { App, Notice, Plugin, PluginSettingTab, Setting, SuggestModal } from 'obsidian';

import { GetNoteApiError } from '../api/client';
import { GetNotePluginHost } from '../host';
import {
	AttachmentTypeOptions,
	DeepContentOptions,
	GetNoteChannelSettings,
	KB_SCOPE_LABELS,
	KB_SCOPES,
	KBScope,
	KBTopic,
} from '../types';
import { runDeviceLogin } from './oauth-login';

/** Human readable error text; `request_id` is appended when the API sent one. */
function failureMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return error instanceof GetNoteApiError && error.requestId.length > 0
		? `${message}（request_id: ${error.requestId}）`
		: message;
}

const FOLDER_LAYOUT_LABELS: Record<string, string> = {
	flat: '平铺',
	'by-type': '按笔记类型',
	'by-date': '按日期',
};

const ATTACHMENT_ROWS: Array<{ key: keyof AttachmentTypeOptions; name: string; desc: string }> = [
	{ key: 'image', name: '图片', desc: '下载图片附件并替换为本地链接。' },
	{ key: 'audio', name: '音频', desc: '下载录音与其他音频附件。' },
	{ key: 'video', name: '视频', desc: '下载视频附件。' },
	{ key: 'document', name: '文档', desc: '下载 PDF、Word 等文档附件。' },
];

const DEEP_CONTENT_ROWS: Array<{ key: keyof DeepContentOptions; name: string; desc: string }> = [
	{ key: 'linkOriginal', name: '原文', desc: '链接笔记抓取的原文全文（web_page.content）。' },
	{ key: 'transcript', name: '转写', desc: '录音笔记的转写文本（audio.original）。' },
	{ key: 'timeline', name: '时间线', desc: '按时间索引的转写片段（timeline.moments）。' },
	{ key: 'meetingTodos', name: '会议待办', desc: '会议记录提取的待办事项（meeting_todos.items）。' },
	{ key: 'quickNote', name: '快捷笔记', desc: '录音过程中记下的快捷笔记（quick_note）。' },
	{ key: 'attachments', name: '附件', desc: '附件清单，已下载到本地时渲染为内部链接。' },
	{ key: 'summary', name: 'AI 摘要', desc: '正文中的 AI 摘要（content）。' },
];

/** 一次性内容导入的知识库选择器；列表由调用方按当前范围取好再传入。 */
class KnowledgeBasePicker extends SuggestModal<KBTopic> {
	constructor(
		app: App,
		private readonly topics: KBTopic[],
		private readonly onPick: (topic: KBTopic) => void,
	) {
		super(app);
		this.setPlaceholder('选择要导入内容的知识库');
	}

	override getSuggestions(query: string): KBTopic[] {
		const needle = query.trim().toLowerCase();
		if (needle.length === 0) return this.topics;
		return this.topics.filter((topic) => topic.name.toLowerCase().includes(needle));
	}

	override renderSuggestion(topic: KBTopic, el: HTMLElement): void {
		el.createEl('div', { text: topic.name });
		el.createEl('small', { text: `${topic.noteCount} 条笔记 · ${topic.scope}` });
	}

	override onChooseSuggestion(topic: KBTopic): void {
		this.onPick(topic);
	}
}

/** Settings tab for the 得到大脑 (Get笔记) channel. */
export class GetNoteSettingTab extends PluginSettingTab {
	private readonly host: GetNotePluginHost;

	constructor(app: App, host: GetNotePluginHost) {
		// The plugin itself implements the host interface, so it can back the setting tab.
		super(app, host as unknown as Plugin);
		this.host = host;
	}

	override async display(): Promise<void> {
		const settings = this.host.getNoteSettings;
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h3', { text: '凭证' });

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('得到大脑开放平台签发的密钥，形如 gk_live_xxx。')
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('gk_live_xxx')
					.setValue(settings.apiKey)
					.onChange(async (value) => {
						settings.apiKey = value.trim();
						this.host.refreshCredentials();
						await this.persist();
					});
			});

		new Setting(containerEl)
			.setName('Client ID')
			.setDesc('开放平台应用的客户端标识，形如 cli_xxx；缺失时接口会返回 401。')
			.addText((text) => {
				text
					.setPlaceholder('cli_xxx')
					.setValue(settings.clientId)
					.onChange(async (value) => {
						settings.clientId = value.trim();
						this.host.refreshCredentials();
						await this.persist();
					});
			});

		new Setting(containerEl)
			.setName('API 地址')
			.setDesc('默认指向生产环境，仅调试时修改。')
			.addText((text) => {
				text
					.setPlaceholder('https://openapi.biji.com/open')
					.setValue(settings.apiBase)
					.onChange(async (value) => {
						settings.apiBase = value.trim() || 'https://openapi.biji.com/open';
						this.host.refreshCredentials();
						await this.persist();
					});
			});

		new Setting(containerEl)
			.setName('笔记网页地址')
			.setDesc('笔记链接（source）使用的前缀，留空则按 API 地址自动推导，仅测试环境需要改。')
			.addText((text) => {
				text
					.setPlaceholder('https://www.biji.com')
					.setValue(settings.webBase)
					.onChange(async (value) => {
						settings.webBase = value.trim();
						this.host.refreshCredentials();
						await this.persist();
					});
			});

		new Setting(containerEl)
			.setName('测试连接')
			.setDesc('用当前凭证请求一次配额接口，验证 API Key 与 Client ID 是否可用。')
			.addButton((button) => {
				button.setButtonText('测试连接').onClick(async () => {
					button.setDisabled(true);
					try {
						this.host.refreshCredentials();
						const quota = await this.host.endpoints.getQuota();
						new Notice(
							quota
								? `连接成功，今日读取额度剩余 ${quota.read.daily.remaining}/${quota.read.daily.limit}。`
								: '连接成功，但接口未返回配额信息。',
						);
					} catch (error) {
						new Notice(failureMessage(error));
					} finally {
						button.setDisabled(false);
					}
				});
			});

		new Setting(containerEl)
			.setName('浏览器授权')
			.setDesc(
				'在浏览器里确认授权码自动换取 API Key，需要先填上面「Client ID」——它必须是你自己在得到大脑开放平台创建的应用，插件无法代你申请；没有应用时可以继续只用 API Key。',
			)
			.addButton((button) => {
				button.setButtonText('浏览器授权').onClick(async () => {
					button.setDisabled(true);
					try {
						await runDeviceLogin(this.host);
					} catch (error) {
						new Notice(failureMessage(error));
					} finally {
						button.setDisabled(false);
					}
				});
			});

		containerEl.createEl('h3', { text: '同步' });

		new Setting(containerEl)
			.setName('笔记目录')
			.setDesc('云端笔记写入这个目录。')
			.addText((text) => {
				text
					.setPlaceholder('get')
					.setValue(settings.targetFolder)
					.onChange(async (value) => {
						settings.targetFolder = value.trim() || 'get';
						await this.persist();
					});
			});

		new Setting(containerEl)
			.setName('目录结构')
			.setDesc('决定笔记在笔记目录下如何分层。')
			.addDropdown((dropdown) => {
				dropdown.addOptions(FOLDER_LAYOUT_LABELS);
				dropdown.setValue(settings.folderLayout);
				dropdown.onChange(async (value) => {
					settings.folderLayout = value as GetNoteChannelSettings['folderLayout'];
					await this.persist();
				});
			});

		new Setting(containerEl)
			.setName('启动时同步')
			.setDesc('Obsidian 启动后自动拉取一次最新笔记。')
			.addToggle((toggle) => {
				toggle.setValue(settings.syncOnStartup).onChange(async (value) => {
					settings.syncOnStartup = value;
					await this.persist();
				});
			});

		new Setting(containerEl)
			.setName('定时间隔')
			.setDesc('自动同步的间隔分钟数，0 表示关闭。')
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text
					.setPlaceholder('0')
					.setValue(String(settings.syncIntervalMinutes))
					.onChange(async (value) => {
						const minutes = Number.parseInt(value, 10);
						settings.syncIntervalMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
						await this.persist();
					});
			});

		new Setting(containerEl)
			.setName('手动同步')
			.setDesc('立即按游标增量拉取云端最新笔记。')
			.addButton((button) => {
				button.setButtonText('立即同步').onClick(async () => {
					button.setDisabled(true);
					syncStatus.setText('同步中…');
					try {
						const report = await this.host.pull.syncLatest((message) => syncStatus.setText(message));
						const failed = report.failed.length > 0 ? ` · 失败 ${report.failed.length}` : '';
						const summary = `新增 ${report.created} · 更新 ${report.updated} · 跳过 ${report.skipped} · 附件 ${report.attachments}${failed}`;
						syncStatus.setText(summary);
						new Notice(`同步完成：${summary}`);
					} catch (error) {
						syncStatus.setText('');
						new Notice(failureMessage(error));
					} finally {
						button.setDisabled(false);
					}
				});
			});
		const syncStatus = containerEl.createDiv({ cls: 'getnote-settings-status' });

		containerEl.createEl('h3', { text: '附件' });
		new Setting(containerEl)
			.setName('附件目录')
			.setDesc('附件下载后写入这个目录。')
			.addText((text) => {
				text
					.setPlaceholder('get attachment')
					.setValue(settings.attachmentFolder)
					.onChange(async (value) => {
						settings.attachmentFolder = value.trim() || 'get attachment';
						await this.persist();
					});
			});

		for (const row of ATTACHMENT_ROWS) {
			new Setting(containerEl)
				.setName(row.name)
				.setDesc(row.desc)
				.addToggle((toggle) => {
					toggle.setValue(settings.attachmentTypes[row.key]).onChange(async (value) => {
						settings.attachmentTypes[row.key] = value;
						await this.persist();
					});
				});
		}

		containerEl.createEl('h3', { text: '深度内容' });

		for (const row of DEEP_CONTENT_ROWS) {
			new Setting(containerEl)
				.setName(row.name)
				.setDesc(row.desc)
				.addToggle((toggle) => {
					toggle.setValue(settings.deepContent[row.key]).onChange(async (value) => {
						settings.deepContent[row.key] = value;
						await this.persist();
					});
				});
		}

		containerEl.createEl('h3', { text: '推送' });

		new Setting(containerEl)
			.setName('启用推送')
			.setDesc('允许把本地笔记推送到得到大脑。')
			.addToggle((toggle) => {
				toggle.setValue(settings.pushEnabled).onChange(async (value) => {
					settings.pushEnabled = value;
					await this.persist();
				});
			});

		new Setting(containerEl)
			.setName('推送目录')
			.setDesc('本地笔记的推送范围，留空表示整个仓库。')
			.addText((text) => {
				text
					.setPlaceholder('留空表示整个仓库')
					.setValue(settings.pushFolder)
					.onChange(async (value) => {
						settings.pushFolder = value.trim();
						await this.persist();
					});
			});

		new Setting(containerEl)
			.setName('链接到本地笔记')
			.setDesc('把指向得到大脑的链接改写成对应的本地笔记链接。')
			.addToggle((toggle) => {
				toggle.setValue(settings.linkToLocalNotes).onChange(async (value) => {
					settings.linkToLocalNotes = value;
					await this.persist();
				});
			});

		new Setting(containerEl)
			.setName('手动推送')
			.setDesc('对当前打开的笔记操作：带 uid 的笔记会更新云端同一条笔记。')
			.addButton((button) => {
				button.setButtonText('推送当前笔记').onClick(async () => {
					const file = this.app.workspace.getActiveFile();
					if (!file) {
						new Notice('当前没有打开的笔记。');
						return;
					}
					button.setDisabled(true);
					try {
						const result = await this.host.push.pushFile(file);
						const action = result.created ? '已创建云端笔记' : '已更新云端笔记';
						new Notice(result.pending ? `${action}，云端仍在处理：${result.noteId}` : `${action}：${result.noteId}`);
					} catch (error) {
						new Notice(failureMessage(error));
					} finally {
						button.setDisabled(false);
					}
				});
			})
			.addButton((button) => {
				button.setButtonText('生成分享链接').onClick(async () => {
					const file = this.app.workspace.getActiveFile();
					if (!file) {
						new Notice('当前没有打开的笔记。');
						return;
					}
					button.setDisabled(true);
					try {
						new Notice(`分享链接：${await this.host.push.shareFile(file)}`, 10_000);
					} catch (error) {
						new Notice(failureMessage(error));
					} finally {
						button.setDisabled(false);
					}
				});
			});

		containerEl.createEl('h3', { text: '召回' });

		new Setting(containerEl)
			.setName('启动时打开召回面板')
			.setDesc('Obsidian 启动后自动在右侧边栏打开语义召回面板。')
			.addToggle((toggle) => {
				toggle.setValue(settings.recall.autoOpen).onChange(async (value) => {
					settings.recall.autoOpen = value;
					await this.persist();
				});
			});

		new Setting(containerEl)
			.setName('召回条数')
			.setDesc('每次语义召回返回的结果数量，接口上限为 10。')
			.addSlider((slider) => {
				slider
					.setLimits(1, 10, 1)
					.setValue(settings.recall.topK)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.recall.topK = value;
						await this.persist();
					});
			});

		let topics: KBTopic[] = [];
		if (settings.apiKey.length > 0 && settings.clientId.length > 0) {
			try {
				topics = await this.host.endpoints.listKnowledgeBases();
			} catch (error) {
				new Notice(failureMessage(error));
			}
		}

		new Setting(containerEl)
			.setName('默认知识库')
			.setDesc('语义召回的检索范围，「全部」表示跨全部笔记检索。')
			.addDropdown((dropdown) => {
				dropdown.addOption('', '全部');
				for (const topic of topics) dropdown.addOption(topic.topicId, topic.name);
				dropdown.setValue(settings.recall.topicId);
				dropdown.onChange(async (value) => {
					settings.recall.topicId = value;
					await this.persist();
				});
			});

		containerEl.createEl('h3', { text: '知识库' });

		new Setting(containerEl)
			.setName('知识库范围')
			.setDesc('知识库列表与内容导入的检索范围；书籍库、顾客档案、团队空间是独立的库，必须选中对应范围才能看到。')
			.addDropdown((dropdown) => {
				for (const scope of KB_SCOPES) dropdown.addOption(scope, KB_SCOPE_LABELS[scope]);
				dropdown.setValue(settings.kbScope);
				dropdown.onChange(async (value) => {
					settings.kbScope = value as KBScope;
					await this.persist();
				});
			});

		containerEl.createEl('h3', { text: '内容导入' });

		new Setting(containerEl)
			.setName('启用内容导入')
			.setDesc('博主内容与直播内容不在笔记接口里，需要单独抓取；开启后随同步一起导入。')
			.addToggle((toggle) => {
				toggle.setValue(settings.content.enabled).onChange(async (value) => {
					settings.content.enabled = value;
					await this.persist();
				});
			});

		new Setting(containerEl)
			.setName('博主内容')
			.setDesc('导入已关注博主发布的文章。')
			.addToggle((toggle) => {
				toggle.setValue(settings.content.bloggers).onChange(async (value) => {
					settings.content.bloggers = value;
					await this.persist();
				});
			});

		new Setting(containerEl)
			.setName('直播内容')
			.setDesc('导入已关注直播的场次记录。')
			.addToggle((toggle) => {
				toggle.setValue(settings.content.lives).onChange(async (value) => {
					settings.content.lives = value;
					await this.persist();
				});
			});

		new Setting(containerEl)
			.setName('导入目录')
			.setDesc('导入内容的存放目录，留空表示跟随笔记目录。')
			.addText((text) => {
				text
					.setPlaceholder('留空表示跟随笔记目录')
					.setValue(settings.content.folder)
					.onChange(async (value) => {
						settings.content.folder = value.trim();
						await this.persist();
					});
			});

		new Setting(containerEl)
			.setName('立即导入')
			.setDesc('先选择一个知识库，再导入其中的博主内容与直播内容。')
			.addButton((button) => {
				button.setButtonText('立即导入').onClick(async () => {
					button.setDisabled(true);
					importStatus.setText('读取知识库…');
					try {
						const scoped = await this.host.endpoints.listKnowledgeBases(settings.kbScope);
						if (scoped.length === 0) {
							importStatus.setText('');
							new Notice(`${KB_SCOPE_LABELS[settings.kbScope]}范围内没有知识库。`);
							return;
						}
						new KnowledgeBasePicker(this.app, scoped, (topic) => {
							void this.importContent(topic, importStatus);
						}).open();
					} catch (error) {
						importStatus.setText('');
						new Notice(failureMessage(error));
					} finally {
						button.setDisabled(false);
					}
				});
			});
		const importStatus = containerEl.createDiv({ cls: 'getnote-settings-status' });
	}

	/** 导入一个知识库的博主/直播内容，计数落到状态行，失败条目单独提示。 */
	private async importContent(topic: KBTopic, status: HTMLElement): Promise<void> {
		status.setText(`正在导入 ${topic.name}…`);
		try {
			const report = await this.host.content.importKnowledgeBaseContent(topic.topicId, topic.name, (message) =>
				status.setText(message),
			);
			const summary = `导入 ${report.imported} 条 · 跳过 ${report.skipped} 条 · 失败 ${report.failed.length} 条`;
			status.setText(summary);
			new Notice(`${topic.name}：${summary}`);
			report.failed.slice(0, 3).forEach((failure) => new Notice(`${failure.title}：${failure.error}`, 8000));
		} catch (error) {
			status.setText('');
			new Notice(failureMessage(error));
		}
	}

	/** Settings are saved after every change; a failed write must not go unnoticed. */
	private async persist(): Promise<void> {
		try {
			await this.host.saveSettings();
		} catch (error) {
			new Notice(`设置保存失败：${failureMessage(error)}`);
		}
	}
}
