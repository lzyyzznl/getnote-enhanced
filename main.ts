import { App, Modal, Notice, Plugin, SuggestModal, TFile, WorkspaceLeaf, addIcon } from 'obsidian';

import { ApiClient, GetNoteApiError } from './src/api/client';
import { GetNoteEndpoints } from './src/api/endpoints';
import { GetNotePluginHost, KB_VIEW_TYPE, RECALL_VIEW_TYPE } from './src/host';
import { PullEngine, SyncReport } from './src/sync/pull';
import { PushEngine } from './src/sync/push';
import { ContentEngine } from './src/sync/content';
import { GetNoteChannelSettings, KBTopic, defaultGetNoteSettings } from './src/types';
import { KnowledgeBaseView } from './src/ui/kb-panel';
import { openDeleteNoteModal, openShareModal, openTagManagerModal } from './src/ui/note-actions';
import { RecallView } from './src/ui/recall-view';
import { renderQuotaPanel } from './src/ui/quota-status';
import { GetNoteSettingTab } from './src/ui/settings-tab';

const GET_NOTES_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
	'stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>' +
	'<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>' +
	'<line x1="16" y1="2" x2="16" y2="22"/><line x1="8" y1="7" x2="13" y2="7"/>' +
	'<line x1="8" y1="11" x2="13" y2="11"/><line x1="8" y1="15" x2="13" y2="15"/></svg>';

interface PluginSettings {
	getnote: GetNoteChannelSettings;
	[key: string]: unknown;
}


function describeFailure(error: unknown): string {
	if (error instanceof GetNoteApiError) {
		return error.requestId.length > 0 ? `${error.message}（request_id: ${error.requestId}）` : error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

function summariseReport(report: SyncReport): string {
	const parts = [`新增 ${report.created}`, `更新 ${report.updated}`, `跳过 ${report.skipped}`, `附件 ${report.attachments}`];
	if (report.failed.length > 0) parts.push(`失败 ${report.failed.length}`);
	return parts.join(' · ');
}

/** Renders the cached quota snapshot inside a modal. */
class QuotaModal extends Modal {
	constructor(app: App, private readonly host: GetNotePluginHost) {
		super(app);
	}

	override onOpen(): void {
		this.contentEl.addClass('getnote-quota-modal');
		void renderQuotaPanel(this.contentEl, this.host).catch((error: unknown) => {
			this.contentEl.createEl('p', { text: `配额读取失败：${describeFailure(error)}` });
		});
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

class KnowledgeBasePicker extends SuggestModal<KBTopic> {
	constructor(
		app: App,
		private readonly topics: KBTopic[],
		private readonly onPick: (topic: KBTopic) => void,
	) {
		super(app);
		this.setPlaceholder('选择要同步的知识库');
	}

	getSuggestions(query: string): KBTopic[] {
		const needle = query.trim().toLowerCase();
		if (needle.length === 0) return this.topics;
		return this.topics.filter((topic) => topic.name.toLowerCase().includes(needle));
	}

	renderSuggestion(topic: KBTopic, el: HTMLElement): void {
		el.createEl('div', { text: topic.name });
		el.createEl('small', { text: `${topic.noteCount} 条笔记 · ${topic.scope}` });
	}

	onChooseSuggestion(topic: KBTopic): void {
		this.onPick(topic);
	}
}

export default class GetNotePlugin extends Plugin implements GetNotePluginHost {
	getNoteSettings: GetNoteChannelSettings = defaultGetNoteSettings();
	apiClient: ApiClient = new ApiClient(() => ({
		apiKey: this.getNoteSettings.apiKey,
		clientId: this.getNoteSettings.clientId,
		apiBase: this.getNoteSettings.apiBase,
		webBase: this.getNoteSettings.webBase,
	}));
	endpoints: GetNoteEndpoints = new GetNoteEndpoints(this.apiClient);
	pull: PullEngine = new PullEngine(this);
	push: PushEngine = new PushEngine(this);
	content: ContentEngine = new ContentEngine(this);
	private progressNotice: Notice | null = null;

	override async onload(): Promise<void> {
		await this.loadSettings();

		addIcon('get-notes', GET_NOTES_ICON);
		this.addRibbonIcon('get-notes', '同步得到大脑笔记', () => void this.runSyncLatest());
		this.addRibbonIcon('search', '得到大脑语义召回', () => void this.openRecallView());
		this.addRibbonIcon('folder-tree', '打开知识库面板', () => void this.openKnowledgeBaseView());

		this.registerView(RECALL_VIEW_TYPE, (leaf: WorkspaceLeaf) => new RecallView(leaf, this));
		this.registerView(KB_VIEW_TYPE, (leaf: WorkspaceLeaf) => new KnowledgeBaseView(leaf, this));
		this.addSettingTab(new GetNoteSettingTab(this.app, this));

		this.addCommand({ id: 'sync-latest-notes', name: '同步最新笔记', callback: () => void this.runSyncLatest() });
		this.addCommand({ id: 'sync-knowledge-base', name: '同步指定知识库', callback: () => void this.pickKnowledgeBaseAndSync() });
		this.addCommand({ id: 'open-recall-view', name: '打开语义召回', callback: () => void this.openRecallView() });
		this.addCommand({ id: 'open-kb-panel', name: '打开知识库面板', callback: () => void this.openKnowledgeBaseView() });
		this.addCommand({ id: 'sync-kb-content', name: '导入知识库内容（博主/直播）', callback: () => void this.pickKnowledgeBaseAndImportContent() });
		this.addCommand({ id: 'recall-selection', name: '以选中文本语义召回', editorCallback: (editor) => void this.recallText(editor.getSelection()) });
		this.addCommand({ id: 'push-active-note', name: '推送当前笔记到得到大脑', checkCallback: (checking) => this.withActiveFile(checking, (file) => this.pushFile(file)) });
		this.addCommand({ id: 'share-active-note', name: '生成当前笔记的分享链接', checkCallback: (checking) => this.withActiveFile(checking, (file) => this.shareFile(file)) });
		this.addCommand({ id: 'delete-cloud-note', name: '删除云端笔记（移入回收站）', checkCallback: (checking) => this.withActiveFile(checking, (file) => openDeleteNoteModal(this, file)) });
		this.addCommand({ id: 'manage-tags', name: '管理当前笔记的标签', checkCallback: (checking) => this.withActiveFile(checking, (file) => openTagManagerModal(this, file)) });
		this.addCommand({ id: 'check-quota', name: '查看接口配额', callback: () => new QuotaModal(this.app, this).open() });

		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor) => {
				const selection = editor.getSelection().trim();
				if (selection.length === 0) return;
				menu.addItem((item) => {
					item.setTitle('以选中文本语义召回').setIcon('search').onClick(() => void this.recallText(selection));
				});
			}),
		);

		// Note-level actions also belong on the file menu: a command-palette-only
		// delete/tag entry is not where anyone looks for a file operation.
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				menu.addItem((item) => {
					item.setTitle('推送当前笔记到得到大脑').setIcon('upload').onClick(() => void this.pushFile(file));
				});
				menu.addItem((item) => {
					item.setTitle('生成分享链接').setIcon('link').onClick(() => void this.shareFile(file));
				});
				menu.addItem((item) => {
					item.setTitle('管理云端标签').setIcon('tags').onClick(() => openTagManagerModal(this, file));
				});
				menu.addItem((item) => {
					item.setTitle('删除云端笔记（移入回收站）').setIcon('trash').onClick(() => openDeleteNoteModal(this, file));
				});
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			// The recall panel is the plugin's main surface; without this it stays
			// hidden behind a command and the plugin looks settings-only.
			if (this.getNoteSettings.recall.autoOpen) void this.openRecallView();
			if (this.getNoteSettings.syncOnStartup) window.setTimeout(() => void this.runSyncLatest(), 2000);
			if (this.getNoteSettings.syncIntervalMinutes > 0) {
				this.registerInterval(window.setInterval(() => void this.runSyncLatest(), this.getNoteSettings.syncIntervalMinutes * 60_000));
			}
		});
	}

	override onunload(): void {
		this.app.workspace.detachLeavesOfType(RECALL_VIEW_TYPE);
		this.app.workspace.detachLeavesOfType(KB_VIEW_TYPE);
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<PluginSettings> | null;
		const defaults = defaultGetNoteSettings();
		this.getNoteSettings = {
			...defaults,
			...(stored?.getnote ?? {}),
			attachmentTypes: { ...defaults.attachmentTypes, ...(stored?.getnote?.attachmentTypes ?? {}) },
			deepContent: { ...defaults.deepContent, ...(stored?.getnote?.deepContent ?? {}) },
			recall: { ...defaults.recall, ...(stored?.getnote?.recall ?? {}) },
			content: { ...defaults.content, ...(stored?.getnote?.content ?? {}) },
			contentIndex: { ...(stored?.getnote?.contentIndex ?? {}) },
			index: { ...(stored?.getnote?.index ?? {}) },
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData({ ...((await this.loadData()) as Record<string, unknown> | null), getnote: this.getNoteSettings });
	}

	refreshCredentials(): void {
		this.apiClient.clearBlock();
	}

	private withActiveFile(checking: boolean, action: (file: TFile) => Promise<unknown>): boolean {
		const file = this.app.workspace.getActiveFile();
		if (!file) return false;
		if (!checking) void action(file).catch((error: unknown) => new Notice(`操作失败：${describeFailure(error)}`));
		return true;
	}

	private reportProgress(message: string): void {
		if (!this.progressNotice) {
			this.progressNotice = new Notice(message, 0);
			return;
		}
		this.progressNotice.setMessage(message);
	}

	private finishProgress(message: string): void {
		this.progressNotice?.hide();
		this.progressNotice = null;
		new Notice(message);
	}

	async runSyncLatest(): Promise<void> {
		try {
			const report = await this.pull.syncLatest((message) => this.reportProgress(message));
			this.finishProgress(`同步完成：${summariseReport(report)}`);
			report.failed.slice(0, 3).forEach((failure) => new Notice(`${failure.title}：${failure.error}`, 8000));
		} catch (error: unknown) {
			this.finishProgress(`同步失败：${describeFailure(error)}`);
		}
	}

	async pickKnowledgeBaseAndSync(): Promise<void> {
		try {
			const topics = await this.endpoints.listKnowledgeBases();
			if (topics.length === 0) {
				new Notice('没有可同步的知识库。');
				return;
			}
			new KnowledgeBasePicker(this.app, topics, (topic) => {
				void this.pull
					.syncKnowledgeBase(topic.topicId, (message) => this.reportProgress(message))
					.then((report) => this.finishProgress(`${topic.name} 同步完成：${summariseReport(report)}`))
					.catch((error: unknown) => this.finishProgress(`同步失败：${describeFailure(error)}`));
			}).open();
		} catch (error: unknown) {
			new Notice(`知识库读取失败：${describeFailure(error)}`);
		}
	}

	async pickKnowledgeBaseAndImportContent(): Promise<void> {
		try {
			const topics = await this.endpoints.listKnowledgeBases();
			if (topics.length === 0) {
				new Notice('没有可导入的知识库。');
				return;
			}
			new KnowledgeBasePicker(this.app, topics, (topic) => {
				void this.content
					.importKnowledgeBaseContent(topic.topicId, topic.name, (message) => this.reportProgress(message))
					.then((report) =>
						this.finishProgress(
							`${topic.name} 导入完成：导入 ${report.imported} · 跳过 ${report.skipped} · 失败 ${report.failed.length}`,
						),
					)
					.catch((error: unknown) => this.finishProgress(`导入失败：${describeFailure(error)}`));
			}).open();
		} catch (error: unknown) {
			new Notice(`知识库读取失败：${describeFailure(error)}`);
		}
	}

	async openRecallView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(RECALL_VIEW_TYPE);
		const leaf = existing.length > 0 ? existing[0] : this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: RECALL_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	async openKnowledgeBaseView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(KB_VIEW_TYPE);
		const leaf = existing.length > 0 ? existing[0] : this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: KB_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	async recallText(text: string): Promise<void> {
		const query = text.trim();
		if (query.length === 0) {
			new Notice('没有选中任何文本。');
			return;
		}
		await this.openRecallView();
		const view = this.app.workspace.getLeavesOfType(RECALL_VIEW_TYPE)[0]?.view;
		if (view instanceof RecallView) {
			view.setQuery(query);
			void view.run();
		}
	}

	async pushFile(file: TFile): Promise<void> {
		try {
			const result = await this.push.pushFile(file);
			new Notice(result.created ? `已创建云端笔记（${result.noteId}）` : `已更新云端笔记（${result.noteId}）`);
		} catch (error: unknown) {
			new Notice(`推送失败：${describeFailure(error)}`, 8000);
		}
	}

	async shareFile(file: TFile): Promise<void> {
		await openShareModal(this, file);
	}
}
