import { TFile, normalizePath } from 'obsidian';

import { GetNoteApiError } from '../api/client';
import { GetNotePluginHost } from '../host';
import { GetNoteChannelSettings, Note, NoteListPage } from '../types';
import {
	RenderContext,
	attachmentTargetPath,
	buildNotePath,
	extractWritableBody,
	readFrontmatterUid,
	renderNoteMarkdown,
	replaceWritableBody,
	shouldDownloadAttachment,
} from './render';

/** `note/list` ignores `limit` and answers 20 notes per page; 20 pages is the run cap. */
const MAX_PAGES = 20;
const NOTE_EXTENSION = '.md';
/** Signed CDN urls are public; only the API host needs the auth headers. */
const AUTHENTICATED_HOST_SUFFIX = 'biji.com';
const BODY_URL_PATTERN = /https?:\/\/[^\s"'<>)\\]*/g;
/** Frontmatter field carrying the remote `updated_at` of the last pull. */
const MODIFIED_FIELD = 'modified';

export interface SyncReport {
	created: number;
	updated: number;
	skipped: number;
	attachments: number;
	failed: Array<{ title: string; error: string }>;
	startedAt: number;
}

interface RunState {
	report: SyncReport;
	/** note id -> `"<vaultPath>|<updatedAt>"`, rehydrated per run and written back per page. */
	index: Map<string, string>;
	/** Set when the API refuses the whole account (quota / membership). */
	aborted: boolean;
	dirty: boolean;
}

/** Index values are `"<vaultPath>|<updatedAt>"`; entries written before the marker existed hold a bare path. */
function readIndexPath(marker: string): string {
	const separator = marker.lastIndexOf('|');
	return separator < 0 ? marker : marker.slice(0, separator);
}

function readIndexUpdatedAt(marker: string): string {
	const separator = marker.lastIndexOf('|');
	return separator < 0 ? '' : marker.slice(separator + 1);
}

/** ISO-8601 timestamps compare correctly as text; an unknown local marker always pulls. */
function isRemoteNewer(remoteUpdatedAt: string, localMarker: string): boolean {
	if (localMarker.length === 0) return true;
	if (remoteUpdatedAt.length === 0) return false;
	const remote = Date.parse(remoteUpdatedAt);
	const local = Date.parse(localMarker);
	if (Number.isNaN(remote) || Number.isNaN(local)) return remoteUpdatedAt !== localMarker;
	return remote > local;
}

/** Reads a single top-level frontmatter scalar; render.ts owns the full YAML surface. */
function readFrontmatterScalar(markdown: string, field: string): string {
	const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
	if (!block) return '';
	for (const line of block[1].split('\n')) {
		const match = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*?)[ \t\r]*$/.exec(line);
		if (!match || match[1] !== field) continue;
		return match[2].replace(/^["']|["']$/g, '');
	}
	return '';
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** Short name for progress and failure messages, never a signed query string. */
function fileNameOf(url: string): string {
	const path = url.split('?')[0];
	const name = path.slice(path.lastIndexOf('/') + 1);
	return name.length > 0 ? name : url;
}

/** Attachment entries plus every url the rendered body references, settings-filtered. */
function collectAttachmentUrls(note: Note, markdown: string, settings: GetNoteChannelSettings): string[] {
	// render.ts resolves attachment urls with `.trim()`, so the map keys must be trimmed too.
	const candidates: string[] = [];
	for (const attachment of note.attachments) {
		const url = (attachment.url ?? '').trim();
		if (url.length > 0) candidates.push(url);
	}
	for (const match of markdown.matchAll(BODY_URL_PATTERN)) candidates.push(match[0]);
	const accepted: string[] = [];
	for (const url of candidates) {
		if (accepted.includes(url)) continue;
		if (!shouldDownloadAttachment(url, settings)) continue;
		accepted.push(url);
	}
	return accepted;
}

/**
 * Cloud -> vault direction.
 *
 * The journal in `settings.index` keeps runs incremental: a note whose remote
 * `updated_at` has not moved past the stored marker is skipped from the list
 * page alone, without a single detail request.
 */
export class PullEngine {
	private readonly host: GetNotePluginHost;

	constructor(host: GetNotePluginHost) {
		this.host = host;
	}

	/** Walks the cloud note list newest-first and pulls whatever changed. */
	async syncLatest(onProgress?: (message: string) => void): Promise<SyncReport> {
		const state = this.createState();
		let cursor = '';
		for (let page = 1; page <= MAX_PAGES; page++) {
			onProgress?.(`读取云端列表第 ${page} 页…`);
			let listing: NoteListPage;
			try {
				listing = await this.host.endpoints.listNotes({ cursor });
			} catch (error) {
				this.record(state, error, 'note/list');
				break;
			}
			for (const note of listing.notes) {
				const stored = state.index.get(note.noteId);
				if (stored !== undefined && !isRemoteNewer(note.updatedAt, readIndexUpdatedAt(stored))) {
					state.report.skipped++;
					continue;
				}
				await this.pullNote(note.noteId, state, onProgress);
				if (state.aborted) break;
			}
			await this.flush(state, false);
			if (state.aborted || !listing.hasMore || listing.cursor.length === 0) break;
			cursor = listing.cursor;
		}
		await this.flush(state, true);
		return state.report;
	}

	/** Pulls one note by id, regardless of the journal. */
	async syncNote(noteId: string, onProgress?: (message: string) => void): Promise<SyncReport> {
		const state = this.createState();
		await this.pullNote(noteId, state, onProgress);
		await this.flush(state, true);
		return state.report;
	}

	/** Pulls every note of a knowledge base. */
	async syncKnowledgeBase(topicId: string, onProgress?: (message: string) => void): Promise<SyncReport> {
		const state = this.createState();
		const seen = new Set<string>();
		for (let page = 1; page <= MAX_PAGES; page++) {
			onProgress?.(`读取知识库第 ${page} 页…`);
			let listing: { notes: Note[]; total: number };
			try {
				listing = await this.host.endpoints.listKnowledgeBaseNotes({ topicId, page });
			} catch (error) {
				this.record(state, error, `knowledge/notes#${page}`);
				break;
			}
			let fresh = 0;
			for (const note of listing.notes) {
				if (note.noteId.length === 0 || seen.has(note.noteId)) continue;
				seen.add(note.noteId);
				fresh++;
				await this.pullNote(note.noteId, state, onProgress);
				if (state.aborted) break;
			}
			await this.flush(state, false);
			// The endpoint already follows `has_more`, so a page that adds no new id
			// means the listing is exhausted rather than a paging contract change.
			if (state.aborted || fresh === 0) break;
		}
		await this.flush(state, true);
		return state.report;
	}

	private createState(): RunState {
		const index = new Map<string, string>();
		for (const [noteId, marker] of Object.entries(this.host.getNoteSettings.index)) index.set(noteId, marker);
		return {
			report: { created: 0, updated: 0, skipped: 0, attachments: 0, failed: [], startedAt: Date.now() },
			index,
			aborted: false,
			dirty: false,
		};
	}

	/** Writes the journal back; `final` also stamps `lastSyncAt`. One settings write per page. */
	private async flush(state: RunState, final: boolean): Promise<void> {
		if (final) {
			this.host.getNoteSettings.lastSyncAt = Date.now();
			state.dirty = true;
		}
		if (!state.dirty) return;
		const index = this.host.getNoteSettings.index;
		for (const [noteId, marker] of state.index) index[noteId] = marker;
		state.dirty = false;
		await this.host.saveSettings();
	}

	private async pullNote(noteId: string, state: RunState, onProgress?: (message: string) => void): Promise<void> {
		let note: Note;
		try {
			note = await this.host.endpoints.getNote(noteId, { originalImages: true });
		} catch (error) {
			this.record(state, error, `笔记 ${noteId}`);
			return;
		}
		const label = note.title.length > 0 ? note.title : noteId;
		onProgress?.(`同步笔记：${label}`);
		try {
			const attachmentPaths = new Map<string, string>();
			const remoteLinks = this.renderNote(note, state, attachmentPaths);
			await this.downloadAttachments(note, remoteLinks, attachmentPaths, state, onProgress);
			// Any attachment that resolves to a vault file changes the render, including
			// one that was already there — gating on new downloads alone makes 附件 flip-flop.
			const markdown = attachmentPaths.size > 0 ? this.renderNote(note, state, attachmentPaths) : remoteLinks;
			await this.writeNote(note, markdown, state, onProgress);
		} catch (error) {
			this.record(state, error, label);
		}
	}

	/** Re-renders on every call so notes pulled earlier in the same run link to each other. */
	private renderNote(note: Note, state: RunState, attachmentPaths: Map<string, string>): string {
		const context: RenderContext = {
			settings: this.host.getNoteSettings,
			attachmentPaths,
			localLinks: this.buildLocalLinks(state),
		};
		return renderNoteMarkdown(note, context);
	}

	private buildLocalLinks(state: RunState): Map<string, string> {
		const links = new Map<string, string>();
		for (const [noteId, marker] of state.index) {
			const path = readIndexPath(marker);
			links.set(noteId, path.endsWith(NOTE_EXTENSION) ? path.slice(0, -NOTE_EXTENSION.length) : path);
		}
		return links;
	}

	/**
	 * Downloads every enabled attachment. Failures are journaled per file and the
	 * note continues: a dead CDN url must not cost the note's text. Every url that
	 * resolves to a vault file is recorded in `attachmentPaths`, which is what
	 * drives the re-render.
	 */
	private async downloadAttachments(
		note: Note,
		markdown: string,
		attachmentPaths: Map<string, string>,
		state: RunState,
		onProgress?: (message: string) => void,
	): Promise<void> {
		const settings = this.host.getNoteSettings;
		const label = note.title.length > 0 ? note.title : note.noteId;
		let written = 0;
		for (const url of collectAttachmentUrls(note, markdown, settings)) {
			if (attachmentPaths.has(url)) continue;
			let target: string;
			try {
				target = normalizePath(attachmentTargetPath(note, url, settings));
			} catch (error) {
				state.report.failed.push({ title: label, error: `附件路径无效：${describeError(error)}` });
				continue;
			}
			if (this.host.app.vault.getAbstractFileByPath(target) instanceof TFile) {
				attachmentPaths.set(url, target);
				continue;
			}
			try {
				const bytes = await this.host.apiClient.fetchBinary(url, isAuthenticatedHost(url));
				await this.ensureFolder(target);
				await this.host.app.vault.createBinary(target, bytes);
				attachmentPaths.set(url, target);
				state.report.attachments++;
				written++;
			} catch (error) {
				state.report.failed.push({
					title: label,
					error: `附件下载失败（${fileNameOf(url)}）：${describeError(error)}`,
				});
			}
		}
		if (written > 0) onProgress?.(`已下载 ${written} 个附件：${label}`);
	}

	/**
	 * Overwrite vs preserve:
	 *  - a file is ours only when its `uid` frontmatter equals the remote note id;
	 *  - when ours AND the cloud copy is not newer than the file's `modified`
	 *    marker, the local writable body wins and only the derived sections below
	 *    it are regenerated;
	 *  - otherwise (not ours, no marker, or a newer cloud copy) the whole file is
	 *    rewritten from the cloud copy.
	 */
	private async writeNote(
		note: Note,
		markdown: string,
		state: RunState,
		onProgress?: (message: string) => void,
	): Promise<void> {
		const label = note.title.length > 0 ? note.title : note.noteId;
		const existing = await this.resolveExistingFile(note, state);
		if (!existing) {
			const target = this.freePath(buildNotePath(note, this.host.getNoteSettings), note.noteId);
			await this.ensureFolder(target);
			await this.host.app.vault.create(target, markdown);
			this.mark(state, note, target);
			state.report.created++;
			onProgress?.(`新建笔记：${label}`);
			return;
		}
		const preserve = readFrontmatterUid(existing.text) === note.noteId && !isRemoteNewer(note.updatedAt, readFrontmatterScalar(existing.text, MODIFIED_FIELD));
		const next = preserve ? replaceWritableBody(markdown, extractWritableBody(existing.text)) : markdown;
		this.mark(state, note, existing.file.path);
		if (next === existing.text) {
			state.report.skipped++;
			onProgress?.(`无变化：${label}`);
			return;
		}
		await this.host.app.vault.modify(existing.file, next);
		state.report.updated++;
		onProgress?.(preserve ? `更新（保留本地正文）：${label}` : `更新（覆盖云端正文）：${label}`);
	}

	/** The journaled path first, then the derived path when its `uid` confirms ownership. */
	private async resolveExistingFile(note: Note, state: RunState): Promise<{ file: TFile; text: string } | null> {
		const journaled = readIndexPath(state.index.get(note.noteId) ?? '');
		if (journaled.length > 0) {
			const candidate = this.host.app.vault.getAbstractFileByPath(journaled);
			if (candidate instanceof TFile) return { file: candidate, text: await this.host.app.vault.read(candidate) };
		}
		const derived = this.host.app.vault.getAbstractFileByPath(normalizePath(buildNotePath(note, this.host.getNoteSettings)));
		if (derived instanceof TFile) {
			const text = await this.host.app.vault.read(derived);
			if (readFrontmatterUid(text) === note.noteId) return { file: derived, text };
		}
		return null;
	}

	private mark(state: RunState, note: Note, path: string): void {
		state.index.set(note.noteId, `${path}|${note.updatedAt}`);
		state.dirty = true;
	}

	/** A different note may already occupy the derived path; never overwrite it. */
	private freePath(path: string, noteId: string): string {
		const target = normalizePath(path);
		if (!this.host.app.vault.getAbstractFileByPath(target)) return target;
		const suffix = ` (${noteId})`;
		return target.endsWith(NOTE_EXTENSION)
			? `${target.slice(0, -NOTE_EXTENSION.length)}${suffix}${NOTE_EXTENSION}`
			: `${target}${suffix}`;
	}

	/** `app.vault.createFolder` is not recursive on every platform, so walk the ancestors. */
	private async ensureFolder(target: string): Promise<void> {
		const parts = target.split('/').slice(0, -1);
		let current = '';
		for (const part of parts) {
			current = current.length === 0 ? part : `${current}/${part}`;
			if (this.host.app.vault.getAbstractFileByPath(current)) continue;
			await this.host.app.vault.createFolder(current);
		}
	}

	/** Journals a failure; quota and membership refusals abort the whole run. */
	private record(state: RunState, error: unknown, title: string): void {
		state.report.failed.push({ title, error: describeError(error) });
		if (error instanceof GetNoteApiError && (error.isNotMember || error.isQuotaExhausted)) state.aborted = true;
	}
}

/** Signed CDN urls (`...biji.com/...`) accept the API credentials; everything else is fetched anonymously. */
function isAuthenticatedHost(url: string): boolean {
	const host = /^https?:\/\/([^/?#]+)/.exec(url)?.[1] ?? '';
	return host === AUTHENTICATED_HOST_SUFFIX || host.endsWith(`.${AUTHENTICATED_HOST_SUFFIX}`);
}
