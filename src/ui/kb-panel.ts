import { ItemView, Modal, Notice, Setting, TFile, WorkspaceLeaf } from 'obsidian';

import { GetNoteApiError } from '../api/client';
import { GetNotePluginHost, KB_VIEW_TYPE } from '../host';
import { readFrontmatterUid } from '../sync/render';
import { KBBlogger, KBBloggerPost, KBDirectoryEntry, KBResourceEntry, KBScope, KB_SCOPES, KB_SCOPE_LABELS, KBTopic, KBLive, Note } from '../types';

const EXCERPT_LIMIT = 120;

/** Human readable error text; the API's `request_id` is appended when present. */
function failureMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return error instanceof GetNoteApiError && error.requestId.length > 0
		? `${message}（request_id: ${error.requestId}）`
		: message;
}

/** Single-field prompt; Obsidian has no built-in one and `window.prompt` is blocked on mobile. */
class TextPromptModal extends Modal {
	constructor(
		app: Modal['app'],
		private readonly title: string,
		private readonly placeholder: string,
		private readonly initial: string,
		private readonly onConfirm: (value: string) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.contentEl.createEl('h4', { text: this.title });
		const input = this.contentEl.createEl('input', { type: 'text', cls: 'getnote-kb-input' });
		input.placeholder = this.placeholder;
		input.value = this.initial;
		input.focus();
		input.select();
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				this.submit(input.value);
			}
		});
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText('确定').setCta().onClick(() => this.submit(input.value)))
			.addButton((button) => button.setButtonText('取消').onClick(() => this.close()));
	}

	override onClose(): void {
		this.contentEl.empty();
	}

	private submit(value: string): void {
		const trimmed = value.trim();
		if (trimmed.length === 0) return;
		this.close();
		this.onConfirm(trimmed);
	}
}

/** Destructive actions in this panel delete cloud folders, so they ask first. */
class ConfirmModal extends Modal {
	constructor(
		app: Modal['app'],
		private readonly question: string,
		private readonly detail: string,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.contentEl.createEl('h4', { text: this.question });
		this.contentEl.createEl('p', { text: this.detail });
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText('删除').setWarning().onClick(() => {
				this.close();
				this.onConfirm();
			}))
			.addButton((button) => button.setButtonText('取消').onClick(() => this.close()));
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Knowledge-base panel: browse and *organise* cloud libraries.
 *
 * The panel owns three views of one selected library (notes / folders / imported
 * content) because they are the same task in practice — find something, file it
 * somewhere, occasionally subscribe or import it. Every mutation re-reads the
 * affected listing instead of patching local state, so the panel never shows a
 * picture the server has already moved on from.
 */
export class KnowledgeBaseView extends ItemView {
	private readonly host: GetNotePluginHost;
	/** `scope` is taken by `ItemView` (Obsidian's keymap scope), hence the prefix. */
	private kbScope: KBScope;
	private source: 'own' | 'subscribed' = 'own';
	private tab: 'notes' | 'directories' | 'content' = 'notes';
	private topics: KBTopic[] = [];
	private selected: KBTopic | null = null;
	private notes: Note[] = [];
	private notesPage = 1;
	private notesHasMore = false;
	private directoryPath: KBDirectoryEntry[] = [];
	private directories: KBDirectoryEntry[] = [];
	private resources: KBResourceEntry[] = [];
	private bloggers: KBBlogger[] = [];
	private lives: KBLive[] = [];
	private postsByFollow: Record<string, KBBloggerPost[]> = {};
	private expandedFollow = '';
	private statusEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private running = false;

	constructor(leaf: WorkspaceLeaf, host: GetNotePluginHost) {
		super(leaf);
		this.host = host;
		this.kbScope = host.getNoteSettings.kbScope;
	}

	getViewType(): string {
		return KB_VIEW_TYPE;
	}

	getDisplayText(): string {
		return '知识库';
	}

	override getIcon(): string {
		return 'folder-tree';
	}

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('getnote-kb-view');

		const scopeRow = root.createDiv({ cls: 'getnote-kb-scope' });
		scopeRow.createSpan({ cls: 'getnote-kb-scope-label', text: '范围' });
		const scopeSelect = scopeRow.createEl('select', { cls: 'getnote-kb-scope-select' });
		for (const scope of KB_SCOPES) scopeSelect.createEl('option', { value: scope, text: KB_SCOPE_LABELS[scope] });
		scopeSelect.value = this.kbScope;
		scopeSelect.addEventListener('change', () => {
			this.kbScope = scopeSelect.value as KBScope;
			this.host.getNoteSettings.kbScope = this.kbScope;
			void this.host.saveSettings();
			void this.loadTopics();
		});

		const sourceRow = root.createDiv({ cls: 'getnote-kb-source' });
		const ownButton = sourceRow.createEl('button', { cls: 'getnote-kb-source-btn', text: '我创建的' });
		const subscribedButton = sourceRow.createEl('button', { cls: 'getnote-kb-source-btn', text: '我订阅的' });
		const refreshButton = sourceRow.createEl('button', { cls: 'getnote-kb-refresh', text: '刷新' });
		ownButton.addEventListener('click', () => {
			this.source = 'own';
			void this.loadTopics();
		});
		subscribedButton.addEventListener('click', () => {
			this.source = 'subscribed';
			void this.loadTopics();
		});
		refreshButton.addEventListener('click', () => void this.reloadDetail());

		const actions = root.createDiv({ cls: 'getnote-kb-actions' });
		const createButton = actions.createEl('button', { cls: 'getnote-kb-action', text: '新建知识库' });
		createButton.addEventListener('click', () => this.promptCreateKnowledgeBase());

		this.statusEl = root.createDiv({ cls: 'getnote-kb-status' });
		this.bodyEl = root.createDiv({ cls: 'getnote-kb-body' });
		this.setStatus('正在读取知识库…', '');

		try {
			await this.loadTopics();
		} catch (error) {
			this.setStatus(`知识库读取失败：${failureMessage(error)}`, 'getnote-kb-error');
		}
	}

	override async onClose(): Promise<void> {
		this.contentEl.empty();
		this.statusEl = null;
		this.bodyEl = null;
		this.notes = [];
		this.topics = [];
		this.directories = [];
		this.resources = [];
		this.bloggers = [];
		this.lives = [];
		this.postsByFollow = {};
	}

	private setStatus(text: string, cls: string): void {
		const status = this.statusEl;
		if (!status) return;
		status.setText(text);
		status.className = cls.length > 0 ? `getnote-kb-status ${cls}` : 'getnote-kb-status';
	}

	/** Every action funnels through here so overlapping clicks cannot interleave requests. */
	private async run(action: () => Promise<void>): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			await action();
		} catch (error) {
			this.setStatus(failureMessage(error), 'getnote-kb-error');
		} finally {
			this.running = false;
		}
	}

	private async loadTopics(): Promise<void> {
		this.topics = this.source === 'own'
			? await this.host.endpoints.listKnowledgeBases(this.kbScope)
			: await this.host.endpoints.listSubscribedKnowledgeBases(this.kbScope);
		const stillListed = this.topics.some((topic) => topic.topicId === this.selected?.topicId);
		if (!stillListed) this.selected = this.topics[0] ?? null;
		this.notesPage = 1;
		this.directoryPath = [];
		this.expandedFollow = '';
		this.postsByFollow = {};
		this.setStatus(`${this.source === 'own' ? '自有' : '订阅'}知识库 ${this.topics.length} 个`, '');
		this.render();
		if (this.selected !== null) await this.reloadDetail();
		else this.clearDetail();
	}

	private clearDetail(): void {
		this.notes = [];
		this.directories = [];
		this.resources = [];
		this.bloggers = [];
		this.lives = [];
		this.render();
	}

	private async reloadDetail(): Promise<void> {
		const topic = this.selected;
		if (topic === null) return;
		if (this.tab === 'notes') {
			const page = await this.host.endpoints.listKnowledgeBaseNotes({ topicId: topic.topicId, page: this.notesPage });
			// Pages accumulate so `hasMore` compares what is on screen against the total.
			this.notes = this.notesPage === 1 ? page.notes : [...this.notes, ...page.notes];
			const total = page.total > 0 ? page.total : this.notes.length;
			this.notesHasMore = this.notes.length < total;
		} else if (this.tab === 'directories') {
			await this.loadDirectory();
		} else {
			const bloggers = await this.host.endpoints.listBloggers(topic.topicId);
			this.bloggers = bloggers.bloggers;
			const lives = await this.host.endpoints.listLives(topic.topicId);
			this.lives = lives.lives;
		}
		this.render();
	}

	private async loadDirectory(): Promise<void> {
		const topic = this.selected;
		if (topic === null) return;
		const current = this.directoryPath.length > 0 ? this.directoryPath[this.directoryPath.length - 1].id : '';
		const listing = await this.host.endpoints.listDirectory(topic.topicId, current);
		this.directories = listing.directories;
		this.resources = listing.resources;
	}

	/** Rebuilds the whole panel: the lists are small and always come from the server. */
	private render(): void {
		const body = this.bodyEl;
		if (body === null) return;
		body.empty();

		if (this.topics.length === 0) {
			body.createDiv({ cls: 'getnote-kb-empty', text: '这个范围下没有知识库。' });
			return;
		}

		const topicList = body.createDiv({ cls: 'getnote-kb-topics' });
		for (const topic of this.topics) {
			const row = topicList.createDiv({ cls: 'getnote-kb-topic' });
			if (topic.topicId === this.selected?.topicId) row.addClass('is-selected');
			row.createSpan({ cls: 'getnote-kb-topic-name', text: topic.name });
			row.createSpan({ cls: 'getnote-kb-topic-meta', text: `${topic.noteCount} 条 · ${topic.scope}` });
			row.addEventListener('click', () => {
				this.selected = topic;
				this.notesPage = 1;
				this.directoryPath = [];
				this.expandedFollow = '';
				this.postsByFollow = {};
				this.render();
				void this.run(() => this.reloadDetail());
			});
		}

		const topic = this.selected;
		if (topic === null) return;

		const tabs = body.createDiv({ cls: 'getnote-kb-tabs' });
		const tabLabels: Array<{ key: 'notes' | 'directories' | 'content'; label: string }> = [
			{ key: 'notes', label: '笔记' },
			{ key: 'directories', label: '目录' },
			{ key: 'content', label: '博主 / 直播' },
		];
		for (const entry of tabLabels) {
			const button = tabs.createEl('button', { cls: 'getnote-kb-tab', text: entry.label });
			if (entry.key === this.tab) button.addClass('is-active');
			button.addEventListener('click', () => {
				if (this.tab === entry.key) return;
				this.tab = entry.key;
				void this.run(() => this.reloadDetail());
			});
		}

		const pane = body.createDiv({ cls: 'getnote-kb-pane' });
		if (this.tab === 'notes') this.renderNotes(pane, topic);
		else if (this.tab === 'directories') this.renderDirectories(pane, topic);
		else this.renderContent(pane, topic);
	}

	private renderNotes(pane: HTMLElement, topic: KBTopic): void {
		const toolbar = pane.createDiv({ cls: 'getnote-kb-toolbar' });
		toolbar.createSpan({ cls: 'getnote-kb-toolbar-label', text: `《${topic.name}》第 ${this.notesPage} 页` });
		const addCurrent = toolbar.createEl('button', { cls: 'getnote-kb-action', text: '把当前笔记加入' });
		addCurrent.addEventListener('click', () => void this.run(() => this.addActiveNote(topic, '')));
		if (this.notesHasMore) {
			const more = toolbar.createEl('button', { cls: 'getnote-kb-action', text: '下一页' });
			more.addEventListener('click', () => {
				this.notesPage++;
				void this.run(() => this.reloadDetail());
			});
		}
		if (this.notesPage > 1) {
			const back = toolbar.createEl('button', { cls: 'getnote-kb-action', text: '上一页' });
			back.addEventListener('click', () => {
				this.notesPage--;
				void this.run(() => this.reloadDetail());
			});
		}

		if (this.notes.length === 0) {
			pane.createDiv({ cls: 'getnote-kb-empty', text: '这个知识库还没有笔记。' });
			return;
		}
		for (const note of this.notes) {
			const row = pane.createDiv({ cls: 'getnote-kb-row' });
			const head = row.createDiv({ cls: 'getnote-kb-row-head' });
			head.createSpan({ cls: 'getnote-kb-row-title', text: note.title.trim() || '未命名笔记' });
			head.createSpan({ cls: 'getnote-kb-row-meta', text: `${note.noteType} · ${note.updatedAt.replace('T', ' ').slice(0, 16)}` });
			const excerpt = note.content.replace(/\s+/g, ' ').trim();
			if (excerpt.length > 0) {
				row.createDiv({
					cls: 'getnote-kb-row-excerpt',
					text: excerpt.length > EXCERPT_LIMIT ? `${excerpt.slice(0, EXCERPT_LIMIT)}…` : excerpt,
				});
			}
			const buttons = row.createDiv({ cls: 'getnote-kb-row-actions' });
			const local = this.localFileFor(note.noteId);
			const openButton = buttons.createEl('button', { cls: 'getnote-kb-action', text: local instanceof TFile ? '打开本地' : '打开网页' });
			openButton.addEventListener('click', () => {
				if (local instanceof TFile) void this.app.workspace.getLeaf(false).openFile(local);
				else if (note.source.length > 0) window.open(note.source, '_blank');
				else window.open(`${this.host.apiClient.getWebBase()}/note/${note.noteId}`, '_blank');
			});
			const removeButton = buttons.createEl('button', { cls: 'getnote-kb-action', text: '移出知识库' });
			removeButton.addEventListener('click', () => void this.run(() => this.removeNote(topic, note.noteId)));
		}
	}

	/** Journal lookup: a note is local only when a completed pull recorded a path for it. */
	private localFileFor(noteId: string): TFile | null {
		const marker = this.host.getNoteSettings.index[noteId] ?? '';
		const separator = marker.lastIndexOf('|');
		const path = separator >= 0 ? marker.slice(0, separator) : marker;
		if (path.length === 0) return null;
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	private renderDirectories(pane: HTMLElement, topic: KBTopic): void {
		const trail = pane.createDiv({ cls: 'getnote-kb-breadcrumb' });
		const rootButton = trail.createEl('button', { cls: 'getnote-kb-crumb', text: topic.name });
		rootButton.addEventListener('click', () => {
			this.directoryPath = [];
			void this.run(() => this.reloadDetail());
		});
		this.directoryPath.forEach((entry, index) => {
			trail.createSpan({ cls: 'getnote-kb-crumb-sep', text: '/' });
			const button = trail.createEl('button', { cls: 'getnote-kb-crumb', text: entry.name });
			button.addEventListener('click', () => {
				this.directoryPath = this.directoryPath.slice(0, index + 1);
				void this.run(() => this.reloadDetail());
			});
		});

		const currentId = this.directoryPath.length > 0 ? this.directoryPath[this.directoryPath.length - 1].id : '';
		const toolbar = pane.createDiv({ cls: 'getnote-kb-toolbar' });
		const addHere = toolbar.createEl('button', { cls: 'getnote-kb-action', text: '把当前笔记加入此文件夹' });
		addHere.addEventListener('click', () => void this.run(() => this.addActiveNote(topic, currentId)));
		const mkdir = toolbar.createEl('button', { cls: 'getnote-kb-action', text: '新建文件夹' });
		mkdir.addEventListener('click', () => this.promptCreateDirectory(topic, currentId));

		if (this.directories.length === 0 && this.resources.length === 0) {
			pane.createDiv({ cls: 'getnote-kb-empty', text: '这个文件夹是空的。' });
		}

		for (const entry of this.directories) {
			const row = pane.createDiv({ cls: 'getnote-kb-row' });
			const head = row.createDiv({ cls: 'getnote-kb-row-head' });
			head.createSpan({ cls: 'getnote-kb-row-title', text: `📁 ${entry.name}` });
			const buttons = row.createDiv({ cls: 'getnote-kb-row-actions' });
			const enter = buttons.createEl('button', { cls: 'getnote-kb-action', text: '进入' });
			enter.addEventListener('click', () => {
				this.directoryPath = [...this.directoryPath, entry];
				void this.run(() => this.reloadDetail());
			});
			const rename = buttons.createEl('button', { cls: 'getnote-kb-action', text: '重命名' });
			rename.addEventListener('click', () => this.promptRenameDirectory(topic, entry));
			const remove = buttons.createEl('button', { cls: 'getnote-kb-action', text: '删除' });
			remove.addEventListener('click', () => this.confirmDeleteDirectory(topic, entry));
		}

		for (const resource of this.resources) {
			const row = pane.createDiv({ cls: 'getnote-kb-row' });
			const head = row.createDiv({ cls: 'getnote-kb-row-head' });
			head.createSpan({ cls: 'getnote-kb-row-title', text: resource.name || resource.noteId });
			head.createSpan({ cls: 'getnote-kb-row-meta', text: `${resource.type} · ${resource.status}` });
			if (resource.noteId.length === 0) continue;
			const buttons = row.createDiv({ cls: 'getnote-kb-row-actions' });
			const remove = buttons.createEl('button', { cls: 'getnote-kb-action', text: '移出知识库' });
			remove.addEventListener('click', () => void this.run(() => this.removeNote(topic, resource.noteId)));
		}
	}

	private renderContent(pane: HTMLElement, topic: KBTopic): void {
		const toolbar = pane.createDiv({ cls: 'getnote-kb-toolbar' });
		const followBlogger = toolbar.createEl('button', { cls: 'getnote-kb-action', text: '订阅博主' });
		followBlogger.addEventListener('click', () => this.promptFollow(topic, 'blogger'));
		const followLive = toolbar.createEl('button', { cls: 'getnote-kb-action', text: '订阅直播' });
		followLive.addEventListener('click', () => this.promptFollow(topic, 'live'));

		if (this.bloggers.length === 0 && this.lives.length === 0) {
			pane.createDiv({ cls: 'getnote-kb-empty', text: '这个知识库没有订阅博主或直播。' });
		}

		for (const blogger of this.bloggers) {
			const row = pane.createDiv({ cls: 'getnote-kb-row' });
			const head = row.createDiv({ cls: 'getnote-kb-row-head' });
			head.createSpan({ cls: 'getnote-kb-row-title', text: `👤 ${blogger.accountName || blogger.followId}` });
			head.createSpan({ cls: 'getnote-kb-row-meta', text: `${blogger.platform} · ${blogger.notesCount} 条 · ${blogger.hookState}` });
			const buttons = row.createDiv({ cls: 'getnote-kb-row-actions' });
			const expand = buttons.createEl('button', { cls: 'getnote-kb-action', text: this.expandedFollow === blogger.followId ? '收起' : '展开内容' });
			expand.addEventListener('click', () => void this.run(() => this.toggleBloggerPosts(topic, blogger)));
			if (blogger.followLink.length > 0) {
				const link = buttons.createEl('button', { cls: 'getnote-kb-action', text: '博主主页' });
				link.addEventListener('click', () => window.open(blogger.followLink, '_blank'));
			}
			if (this.expandedFollow === blogger.followId) {
				const posts = this.postsByFollow[blogger.followId] ?? [];
				if (posts.length === 0) row.createDiv({ cls: 'getnote-kb-empty', text: '没有可导入的内容。' });
				for (const post of posts) {
					const postRow = row.createDiv({ cls: 'getnote-kb-post' });
					postRow.createSpan({ cls: 'getnote-kb-post-title', text: post.title || post.postId });
					postRow.createSpan({ cls: 'getnote-kb-post-meta', text: post.publishTime.slice(0, 16) });
					const importButton = postRow.createEl('button', { cls: 'getnote-kb-action', text: '导入' });
					importButton.addEventListener('click', () =>
						void this.run(() => this.importPost(topic, 'blogger', post.postId, blogger.accountName)),
					);
				}
			}
		}

		for (const live of this.lives) {
			const row = pane.createDiv({ cls: 'getnote-kb-row' });
			const head = row.createDiv({ cls: 'getnote-kb-row-head' });
			head.createSpan({ cls: 'getnote-kb-row-title', text: `🎙 ${live.name || live.liveId}` });
			head.createSpan({ cls: 'getnote-kb-row-meta', text: live.status });
			const buttons = row.createDiv({ cls: 'getnote-kb-row-actions' });
			const detail = buttons.createEl('button', { cls: 'getnote-kb-action', text: '查看摘要' });
			detail.addEventListener('click', () => void this.run(() => this.showLive(topic, live)));
			const importButton = buttons.createEl('button', { cls: 'getnote-kb-action', text: '导入' });
			importButton.addEventListener('click', () => void this.run(() => this.importPost(topic, 'live', live.liveId, live.name)));
		}
	}

	private async toggleBloggerPosts(topic: KBTopic, blogger: KBBlogger): Promise<void> {
		if (this.expandedFollow === blogger.followId) {
			this.expandedFollow = '';
			this.render();
			return;
		}
		this.expandedFollow = blogger.followId;
		this.setStatus(`读取《${blogger.accountName}》内容…`, '');
		const page = await this.host.endpoints.listBloggerPosts(topic.topicId, blogger.followId);
		this.postsByFollow = { ...this.postsByFollow, [blogger.followId]: page.posts };
		this.setStatus(`《${blogger.accountName}》内容 ${page.posts.length} 条（total=${page.total}）`, '');
		this.render();
	}

	private async showLive(topic: KBTopic, live: KBLive): Promise<void> {
		const detail = await this.host.endpoints.getLive(topic.topicId, live.liveId);
		this.setStatus(`《${detail.title}》摘要 ${detail.summary.length} 字 / 原文 ${detail.mediaText.length} 字`, '');
		new Notice(`${detail.title}\n\n${detail.summary.slice(0, 300)}`, 12_000);
	}

	private promptCreateKnowledgeBase(): void {
		new TextPromptModal(this.app, '新建知识库', '知识库名称', '', (name) => {
			void this.run(async () => {
				await this.host.endpoints.createKnowledgeBase(name);
				// `knowledge/create` returns no usable id, so re-list instead of guessing.
				await this.loadTopics();
				this.setStatus(`已创建知识库「${name}」`, '');
			});
		}).open();
	}

	private promptCreateDirectory(topic: KBTopic, parentId: string): void {
		new TextPromptModal(this.app, '新建文件夹', '文件夹名称', '', (name) => {
			void this.run(async () => {
				await this.host.endpoints.createDirectory(topic.topicId, name, parentId);
				await this.loadDirectory();
				this.setStatus(`已在「${topic.name}」新建文件夹「${name}」`, '');
				this.render();
			});
		}).open();
	}

	private promptRenameDirectory(topic: KBTopic, entry: KBDirectoryEntry): void {
		new TextPromptModal(this.app, '重命名文件夹', '新的名称', entry.name, (name) => {
			void this.run(async () => {
				await this.host.endpoints.updateDirectory(topic.topicId, entry.id, { name });
				await this.loadDirectory();
				this.setStatus(`文件夹已重命名为「${name}」`, '');
				this.render();
			});
		}).open();
	}

	private confirmDeleteDirectory(topic: KBTopic, entry: KBDirectoryEntry): void {
		new ConfirmModal(this.app, `删除文件夹「${entry.name}」？`, '接口只允许删除空文件夹；失败时请先移出其中的笔记。', () => {
			void this.run(async () => {
				await this.host.endpoints.deleteDirectory(topic.topicId, entry.id);
				await this.loadDirectory();
				this.setStatus(`已删除文件夹「${entry.name}」`, '');
				this.render();
			});
		}).open();
	}

	private promptFollow(topic: KBTopic, kind: 'blogger' | 'live'): void {
		const label = kind === 'blogger' ? '博主链接（抖音）' : '直播链接（得到）';
		new TextPromptModal(this.app, kind === 'blogger' ? '订阅博主' : '订阅直播', label, '', (link) => {
			void this.run(async () => {
				const result = kind === 'blogger'
					? await this.host.endpoints.followBlogger(topic.topicId, link)
					: await this.host.endpoints.followLive(topic.topicId, link);
				await this.reloadDetail();
				this.setStatus(`订阅已提交（follow_id: ${result.followId}）`, '');
			});
		}).open();
	}

	/** Requires the active note to carry a `uid`, i.e. to exist in the cloud already. */
	private async addActiveNote(topic: KBTopic, directoryId: string): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (file === null) {
			this.setStatus('没有打开的笔记。', 'getnote-kb-error');
			return;
		}
		const markdown = await this.app.vault.read(file);
		const noteId = readFrontmatterUid(markdown);
		if (noteId.length === 0) {
			this.setStatus(`「${file.basename}」还没有云端笔记，请先推送。`, 'getnote-kb-error');
			return;
		}
		const added = await this.host.endpoints.addNotesToKnowledgeBase(topic.topicId, [noteId], directoryId);
		await this.reloadDetail();
		this.setStatus(`已把「${file.basename}」加入「${topic.name}」（${added} 条）`, '');
	}

	private async removeNote(topic: KBTopic, noteId: string): Promise<void> {
		await this.host.endpoints.removeNotesFromKnowledgeBase(topic.topicId, [noteId]);
		await this.reloadDetail();
		this.setStatus(`已从「${topic.name}」移出 ${noteId}`, '');
	}

	private async importPost(topic: KBTopic, kind: 'blogger' | 'live', postId: string, ownerName: string): Promise<void> {
		this.setStatus(`正在导入 ${postId}…`, '');
		const path = await this.host.content.importPost(topic.topicId, topic.name, kind, postId, ownerName);
		this.setStatus(`已导入到 ${path}`, '');
	}
}
