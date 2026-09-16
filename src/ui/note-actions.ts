import { ButtonComponent, Modal, Notice, Setting, TFile } from 'obsidian';

import { GetNoteApiError } from '../api/client';
import { GetNotePluginHost } from '../host';
import { readFrontmatterUid } from '../sync/render';
import { NoteTag, UID_FIELD } from '../types';

/** 只有这些类型带音频，分享时默认排除（其余类型勾选没有意义）。 */
const AUDIO_NOTE_TYPES: Record<string, true> = { recorder: true, meeting: true, audio: true };

/** 前导 frontmatter 块；`inner` 之外的字节一律原样保留。 */
const FRONTMATTER_BLOCK = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---)/;
const NOTE_TYPE_LINE = /^[ \t]*note_type[ \t]*:(.*)$/m;
const TAGS_LINE = /^[ \t]*tags[ \t]*:/;
const TAGS_ITEM_LINE = /^[ \t]+-/;

/** YAML 会当成结构符号、或重新定型的取值：这类标签名不加引号就读不回来。 */
const YAML_RISKY = /[:#,[\]{}&*!|>%@`"'\n]|^[-?\s]|\s$|^(?:[+-]?\d+(?:\.\d+)?|true|false|yes|no|on|off|null|~)$/i;

const STATUS_CLASS = 'getnote-note-actions-status';
/** 错误文案多带一个 class，样式表据此上色。 */
const STATUS_ERROR_CLASS = `${STATUS_CLASS} getnote-note-actions-status-error`;

/** 给用户看的错误文案：接口的 `request_id` 是排查时唯一能对上号的线索。 */
function failureMessage(error: unknown): string {
	if (error instanceof GetNoteApiError && error.requestId.length > 0) {
		return `${error.message}（request_id: ${error.requestId}）`;
	}
	return error instanceof Error ? error.message : String(error);
}

/** 同步日志的值是 `"<本地路径>|<updatedAt>"`；更早的条目只存路径。 */
function indexPath(marker: string): string {
	const separator = marker.lastIndexOf('|');
	return separator < 0 ? marker : marker.slice(0, separator);
}

/** 标签名写回 frontmatter 的取值：引号内的 `\` 与 `"` 按 YAML 规则转义。 */
function tagScalar(name: string): string {
	if (!YAML_RISKY.test(name)) return name;
	return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 当前文件对应的云端笔记 id。三个操作改的都是云端数据，所以没关联就抛错，
 * 让命令层提示用户，而不是对着一个空 id 发请求。
 */
function requireNoteId(host: GetNotePluginHost, file: TFile, markdown: string): string {
	const uid = readFrontmatterUid(markdown).trim();
	if (uid.length > 0) return uid;
	// 同步器早期版本只写日志、不写 `uid`，所以按路径反查一次。
	for (const [noteId, marker] of Object.entries(host.getNoteSettings.index)) {
		if (indexPath(marker) === file.path) return noteId;
	}
	throw new Error(`「${file.basename}」未关联云端笔记：缺少 ${UID_FIELD} 字段，同步记录里也找不到它。`);
}

/** frontmatter 的 `note_type`，去掉 YAML 引号；没有该字段时为空串。 */
function readFrontmatterNoteType(markdown: string): string {
	const front = FRONTMATTER_BLOCK.exec(markdown);
	if (!front) return '';
	const line = NOTE_TYPE_LINE.exec(front[2]);
	if (!line) return '';
	const value = line[1].trim();
	const quoted = /^(['"])(.*)\1$/.exec(value);
	return (quoted ? quoted[2] : value.replace(/[ \t]+#.*$/, '').trim()).toLowerCase();
}

/**
 * 把 frontmatter 的 `tags:` 列表换成 `tags`，其余字节不动。
 *
 * 标签的事实来源是云端：本地留着刚删掉的标签，下次推送会把它当新标签传回去。
 * 列表为空时整块删除；没有 frontmatter 时才补一个，避免在正文里乱插字段。
 */
export function replaceFrontmatterTags(markdown: string, tags: string[]): string {
	const entries = tags.map((tag) => `  - ${tagScalar(tag)}`);
	const block = entries.length === 0 ? [] : ['tags:', ...entries];
	const front = FRONTMATTER_BLOCK.exec(markdown);
	if (!front) return block.length === 0 ? markdown : `---\n${block.join('\n')}\n---\n${markdown}`;

	const [, open, inner, close] = front;
	const eol = inner.includes('\r\n') ? '\r\n' : '\n';
	const rows = inner.split(/\r?\n/);
	const start = rows.findIndex((row) => TAGS_LINE.test(row));
	if (start < 0) {
		if (block.length === 0) return markdown;
		// 有 frontmatter 但没有 tags 字段：追加到块尾，块本来就空时不要留空行。
		if (rows.length === 1 && rows[0].trim().length === 0) rows.length = 0;
		rows.push(...block);
	} else {
		let end = start + 1;
		while (end < rows.length && TAGS_ITEM_LINE.test(rows[end])) end += 1;
		rows.splice(start, end - start, ...block);
	}
	return open + rows.join(eol) + close + markdown.slice(front[0].length);
}

/** 删除只是移入回收站，文案必须说清，否则用户会以为本地文件也没了。 */
class DeleteNoteModal extends Modal {
	constructor(
		private readonly host: GetNotePluginHost,
		private readonly file: TFile,
		private readonly noteId: string,
	) {
		super(host.app);
	}

	override onOpen(): void {
		this.contentEl.addClass('getnote-note-actions-modal');
		this.titleEl.setText('删除云端笔记');
		this.contentEl.createEl('p', {
			text: `「${this.file.basename}」将从得到大脑移入回收站，本地文件保留。`,
		});
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText('取消').onClick(() => this.close()))
			.addButton((button) => button.setButtonText('删除').setWarning().onClick(() => void this.remove(button)));
	}

	override onClose(): void {
		this.contentEl.empty();
	}

	private async remove(button: ButtonComponent): Promise<void> {
		button.setDisabled(true);
		try {
			await this.host.endpoints.deleteNote(this.noteId);
			new Notice(`「${this.file.basename}」已移入得到大脑回收站，可在得到大脑中恢复。`);
			this.close();
		} catch (error) {
			button.setDisabled(false);
			new Notice(`删除失败：${failureMessage(error)}`, 8000);
		}
	}
}

/** 标签面板：云端是事实来源，本地 frontmatter 只是镜像。 */
class TagManagerModal extends Modal {
	private tags: NoteTag[] = [];
	private listEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private inputEl: HTMLInputElement | null = null;
	private busy = false;

	constructor(
		private readonly host: GetNotePluginHost,
		private readonly file: TFile,
		private readonly noteId: string,
	) {
		super(host.app);
	}

	override onOpen(): void {
		this.contentEl.addClass('getnote-note-actions-modal');
		this.titleEl.setText('管理当前笔记的标签');
		this.contentEl.createEl('p', {
			text: `增删会同时作用于云端笔记和本地文件的 tags 列表：「${this.file.basename}」。`,
		});
		this.statusEl = this.contentEl.createDiv({ cls: STATUS_CLASS });
		this.listEl = this.contentEl.createDiv({ cls: 'getnote-note-actions-tags' });
		new Setting(this.contentEl)
			.setName('添加标签')
			.addText((text) => {
				text.setPlaceholder('标签名称');
				// 与 Obsidian 其他输入框一致：回车等同于点「添加」。
				text.inputEl.addEventListener('keydown', (event) => {
					if (event.key === 'Enter') void this.add(text.inputEl.value);
				});
				this.inputEl = text.inputEl;
			})
			.addButton((button) => button.setButtonText('添加').setCta().onClick(() => void this.add(this.inputEl?.value ?? '')));

		this.setStatus('读取标签中…', STATUS_CLASS);
		void this.load();
	}

	override onClose(): void {
		this.contentEl.empty();
		this.tags = [];
		this.listEl = null;
		this.statusEl = null;
		this.inputEl = null;
	}

	private async load(): Promise<void> {
		try {
			await this.fetchTags();
			this.setStatus(`共 ${this.tags.length} 个标签。`, STATUS_CLASS);
		} catch (error) {
			this.setStatus(`读取标签失败：${failureMessage(error)}`, STATUS_ERROR_CLASS);
		}
	}

	private async add(name: string): Promise<void> {
		const value = name.trim();
		if (value.length === 0) {
			this.setStatus('请输入标签名称。', STATUS_ERROR_CLASS);
			return;
		}
		if (this.busy) return;
		this.busy = true;
		this.setStatus(`正在添加「${value}」…`, STATUS_CLASS);
		try {
			await this.host.endpoints.addTags(this.noteId, [value]);
			await this.syncLocalCopy();
			if (this.inputEl) this.inputEl.value = '';
			this.setStatus(`已添加「${value}」。`, STATUS_CLASS);
		} catch (error) {
			this.setStatus(`添加标签失败：${failureMessage(error)}`, STATUS_ERROR_CLASS);
		} finally {
			this.busy = false;
		}
	}

	private async remove(tag: NoteTag): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.setStatus(`正在删除「${tag.name}」…`, STATUS_CLASS);
		try {
			await this.host.endpoints.deleteTag(this.noteId, tag.id);
			await this.syncLocalCopy();
			this.setStatus(`已删除「${tag.name}」。`, STATUS_CLASS);
		} catch (error) {
			this.setStatus(`删除标签失败：${failureMessage(error)}`, STATUS_ERROR_CLASS);
		} finally {
			this.busy = false;
		}
	}

	private async fetchTags(): Promise<void> {
		this.tags = (await this.host.endpoints.getNote(this.noteId)).tags;
		this.renderTags();
	}

	/**
	 * 云端标签刚变过，把本地 frontmatter 对齐到云端结果。
	 *
	 * 只在增删之后做，打开面板不改文件：用户手写的 tags 可能在本地是刻意的，
	 * 但增删之后本地必须跟着云端走，否则下次推送会把刚删的标签传回去。
	 */
	private async syncLocalCopy(): Promise<void> {
		await this.fetchTags();
		const markdown = await this.host.app.vault.read(this.file);
		const names = [...new Set(this.tags.map((tag) => tag.name.trim()).filter((name) => name.length > 0))];
		const patched = replaceFrontmatterTags(markdown, names);
		if (patched === markdown) return;
		try {
			await this.host.app.vault.modify(this.file, patched);
		} catch (error) {
			// 云端已经改完，本地只是镜像失败，提示即可，不要让用户以为操作没生效。
			new Notice(`本地文件标签写入失败：${failureMessage(error)}`, 8000);
		}
	}

	private renderTags(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();
		if (this.tags.length === 0) {
			list.createDiv({ cls: 'getnote-note-actions-empty', text: '这条笔记还没有标签。' });
			return;
		}
		for (const tag of this.tags) {
			new Setting(list)
				.setName(tag.name)
				.addButton((button) => button.setButtonText('删除').setWarning().onClick(() => void this.remove(tag)));
		}
	}

	private setStatus(text: string, cls: string): void {
		if (this.statusEl) {
			this.statusEl.setText(text);
			this.statusEl.className = cls;
		}
	}
}

/** 分享链接是公开的，先确认再生成；音频默认排除是录音类笔记的常规诉求。 */
class ShareNoteModal extends Modal {
	private excludeAudio: boolean;
	private statusEl: HTMLElement | null = null;
	private resultEl: HTMLElement | null = null;

	constructor(
		private readonly host: GetNotePluginHost,
		private readonly file: TFile,
		private readonly noteId: string,
		excludeAudio: boolean,
	) {
		super(host.app);
		this.excludeAudio = excludeAudio;
	}

	override onOpen(): void {
		this.contentEl.addClass('getnote-note-actions-modal');
		this.titleEl.setText('生成分享链接');
		this.contentEl.createEl('p', {
			text: `生成后任何拿到链接的人都能查看「${this.file.basename}」，请确认内容可以公开。`,
		});
		new Setting(this.contentEl)
			.setName('排除音频')
			.setDesc('分享内容中不包含录音与转写文本。')
			.addToggle((toggle) => {
				toggle.setValue(this.excludeAudio);
				toggle.onChange((value) => {
					this.excludeAudio = value;
				});
			});
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText('取消').onClick(() => this.close()))
			.addButton((button) => button.setButtonText('生成分享链接').setCta().onClick(() => void this.share(button)));

		this.statusEl = this.contentEl.createDiv({ cls: STATUS_CLASS });
		this.resultEl = this.contentEl.createDiv({ cls: 'getnote-note-actions-share' });
	}

	override onClose(): void {
		this.contentEl.empty();
		this.statusEl = null;
		this.resultEl = null;
	}

	private async share(button: ButtonComponent): Promise<void> {
		button.setDisabled(true);
		this.setStatus('正在生成分享链接…', STATUS_CLASS);
		try {
			const url = await this.host.endpoints.shareNote(this.noteId, this.excludeAudio);
			const result = this.resultEl;
			if (result) {
				result.empty();
				result.createEl('a', { cls: 'getnote-note-actions-share-url', text: url, href: url });
			}
			this.setStatus('链接已生成，可复制后分享。', STATUS_CLASS);
			new Notice(`分享链接：${url}`, 10_000);
		} catch (error) {
			this.setStatus(`生成分享链接失败：${failureMessage(error)}`, STATUS_ERROR_CLASS);
		} finally {
			button.setDisabled(false);
		}
	}

	private setStatus(text: string, cls: string): void {
		if (this.statusEl) {
			this.statusEl.setText(text);
			this.statusEl.className = cls;
		}
	}
}

export async function openDeleteNoteModal(host: GetNotePluginHost, file: TFile): Promise<void> {
	const markdown = await host.app.vault.read(file);
	new DeleteNoteModal(host, file, requireNoteId(host, file, markdown)).open();
}

export async function openTagManagerModal(host: GetNotePluginHost, file: TFile): Promise<void> {
	const markdown = await host.app.vault.read(file);
	new TagManagerModal(host, file, requireNoteId(host, file, markdown)).open();
}

export async function openShareModal(host: GetNotePluginHost, file: TFile): Promise<void> {
	const markdown = await host.app.vault.read(file);
	// frontmatter 里的 note_type 决定默认值：录音/会议类笔记默认不分享音频。
	const excludeAudio = AUDIO_NOTE_TYPES[readFrontmatterNoteType(markdown)] === true;
	new ShareNoteModal(host, file, requireNoteId(host, file, markdown), excludeAudio).open();
}
