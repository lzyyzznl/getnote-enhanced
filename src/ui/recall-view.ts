import { ItemView, Notice, TFile, WorkspaceLeaf } from 'obsidian';

import { GetNoteApiError } from '../api/client';
import { GetNotePluginHost, RECALL_VIEW_TYPE } from '../host';
import { RecallResult } from '../types';

const EXCERPT_LIMIT = 240;

/** Human readable error text; `request_id` is appended when the API sent one. */
function failureMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return error instanceof GetNoteApiError && error.requestId.length > 0
		? `${message}（request_id: ${error.requestId}）`
		: message;
}

/** 语义召回 side panel: query the cloud, then open or sync the matching note. */
export class RecallView extends ItemView {
	private readonly host: GetNotePluginHost;
	private queryInput: HTMLInputElement | null = null;
	private scopeSelect: HTMLSelectElement | null = null;
	private runButton: HTMLButtonElement | null = null;
	private statusEl: HTMLElement | null = null;
	private resultsEl: HTMLElement | null = null;
	private results: RecallResult[] = [];
	private query = '';
	private failureText = '';
	private running = false;

	constructor(leaf: WorkspaceLeaf, host: GetNotePluginHost) {
		super(leaf);
		this.host = host;
	}

	getViewType(): string {
		return RECALL_VIEW_TYPE;
	}

	getDisplayText(): string {
		return '语义召回';
	}

	override getIcon(): string {
		return 'search';
	}

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('getnote-recall-view');

		const controls = root.createDiv({ cls: 'getnote-recall-controls' });
		const input = controls.createEl('input', {
			cls: 'getnote-recall-input',
			type: 'text',
			placeholder: '输入问题或关键词',
			value: this.query,
		});
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') void this.run();
		});
		const scope = controls.createEl('select', { cls: 'getnote-recall-scope' });
		scope.createEl('option', { value: '', text: '全部' });
		const runButton = controls.createEl('button', { cls: 'getnote-recall-run', text: '召回' });
		runButton.addEventListener('click', () => void this.run());

		this.queryInput = input;
		this.scopeSelect = scope;
		this.runButton = runButton;
		this.statusEl = root.createDiv({ cls: 'getnote-recall-status' });
		this.resultsEl = root.createDiv({ cls: 'getnote-recall-results' });
		this.setStatus('输入问题后点击「召回」。', '');

		try {
			const topics = await this.host.endpoints.listKnowledgeBases();
			for (const topic of topics) scope.createEl('option', { value: topic.topicId, text: topic.name });
		} catch (error) {
			new Notice(failureMessage(error));
		}
		const remembered = this.host.getNoteSettings.recall.topicId;
		if (remembered.length > 0) scope.value = remembered;
	}

	override async onClose(): Promise<void> {
		this.contentEl.empty();
		this.queryInput = null;
		this.scopeSelect = null;
		this.runButton = null;
		this.statusEl = null;
		this.resultsEl = null;
		this.results = [];
	}

	/** Pre-fills the query box; used by the plugin's command handlers. */
	setQuery(query: string): void {
		this.query = query;
		if (this.queryInput) this.queryInput.value = query;
	}

	async run(): Promise<void> {
		if (this.running) return;
		const query = (this.queryInput ? this.queryInput.value : this.query).trim();
		if (query.length === 0) {
			this.setStatus('请输入查询内容。', 'getnote-recall-status-error');
			return;
		}
		const topicId = this.scopeSelect ? this.scopeSelect.value : '';
		const topK = this.host.getNoteSettings.recall.topK;

		this.running = true;
		if (this.runButton) this.runButton.disabled = true;
		this.results = [];
		this.failureText = '';
		this.setStatus('召回中…', '');
		this.renderResults();
		try {
			this.results =
				topicId.length > 0
					? await this.host.endpoints.recallKnowledgeBase(topicId, query, topK)
					: await this.host.endpoints.recall(query, topK);
			this.setStatus(`召回完成，共 ${this.results.length} 条结果。`, '');
		} catch (error) {
			this.failureText = `召回失败：${failureMessage(error)}`;
			this.setStatus('', '');
		} finally {
			this.running = false;
			if (this.runButton) this.runButton.disabled = false;
			this.renderResults();
		}
	}

	private setStatus(text: string, cls: string): void {
		const status = this.statusEl;
		if (!status) return;
		status.setText(text);
		status.className = cls.length > 0 ? `getnote-recall-status ${cls}` : 'getnote-recall-status';
	}

	private renderResults(): void {
		const list = this.resultsEl;
		if (!list) return;
		list.empty();
		if (this.running) return;
		if (this.failureText.length > 0) {
			list.createDiv({ cls: 'getnote-recall-error', text: this.failureText });
			return;
		}
		if (this.results.length === 0) {
			list.createDiv({ cls: 'getnote-recall-empty', text: '没有找到相关笔记。' });
			return;
		}
		for (const result of this.results) {
			const card = list.createDiv({ cls: 'getnote-recall-card' });
			const header = card.createDiv({ cls: 'getnote-recall-card-header' });
			header.createSpan({ cls: 'getnote-recall-card-title', text: result.title.trim() || '未命名笔记' });
			header.createSpan({ cls: 'getnote-recall-card-type', text: result.noteType });
			header.createSpan({ cls: 'getnote-recall-card-date', text: result.createdAt.replace('T', ' ').slice(0, 16) });
			const excerpt = result.content.replace(/\s+/g, ' ').trim();
			if (excerpt.length > 0) {
				card.createDiv({
					cls: 'getnote-recall-card-excerpt',
					text: excerpt.length > EXCERPT_LIMIT ? `${excerpt.slice(0, EXCERPT_LIMIT)}…` : excerpt,
				});
			}

			// `index[noteId]` holds `"<vault path>|<updatedAt>"`; older journals stored bare paths.
			const marker = this.host.getNoteSettings.index[result.noteId] ?? '';
			const separator = marker.lastIndexOf('|');
			const path = separator >= 0 ? marker.slice(0, separator) : marker;
			const file = path.length > 0 ? this.app.vault.getAbstractFileByPath(path) : null;
			card.addEventListener('click', () => {
				if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
				else window.open(result.noteUrl, '_blank');
			});
			if (!(file instanceof TFile)) {
				const syncButton = card.createEl('button', { cls: 'getnote-recall-sync', text: '同步到本地' });
				syncButton.addEventListener('click', (event) => {
					event.stopPropagation();
					void this.syncResult(result);
				});
			}
		}
	}

	private async syncResult(result: RecallResult): Promise<void> {
		try {
			const report = await this.host.pull.syncNote(result.noteId, (message) => this.setStatus(message, ''));
			const failed = report.failed.length > 0 ? ` · 失败 ${report.failed.length}` : '';
			this.failureText = '';
			this.setStatus(
				`已同步：新增 ${report.created} · 更新 ${report.updated} · 跳过 ${report.skipped} · 附件 ${report.attachments}${failed}`,
				'',
			);
		} catch (error) {
			new Notice(failureMessage(error));
		}
		this.renderResults();
	}
}
