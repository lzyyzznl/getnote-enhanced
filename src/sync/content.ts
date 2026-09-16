import { TFile } from 'obsidian';

import { GetNoteApiError } from '../api/client';
import { GetNotePluginHost } from '../host';
import { ContentEntry, ContentKind, GetNoteChannelSettings, KBBlogger, KBBloggerPost, KBLive } from '../types';
import { joinVaultPath, sanitiseFileName } from './render';

/**
 * Blogger posts and live sessions imported out of a knowledge base.
 *
 * These files are imports, NOT notes: the cloud exposes no write endpoint for
 * them, so they never carry the `<!-- getnote:content:start -->` region markers,
 * are never pushed back, and are deliberately kept out of `settings.index` — an
 * entry there would make `PullEngine` look for a note detail that does not exist
 * and `PushEngine` upload an imported post as a new note.
 *
 * `settings.contentIndex` is the import journal (`postId -> "<vaultPath>|<publishTime>"`).
 * It is rehydrated into a run-local map and written back once per run, so a
 * second run on unchanged content performs no file write at all.
 */

/** Content listings page like the note list; 20 pages per loop is the run cap. */
const MAX_PAGES = 20;
const MARKDOWN_EXTENSION = '.md';
/** Ids are sanitised with the same cap `render.ts` uses for note ids. */
const MAX_ID_LENGTH = 64;
const DEFAULT_FOLDER = '知识库内容';
const UNTITLED_CONTENT = '未命名内容';
const MARKER_SEPARATOR = '|';
/** Track -> subfolder of the knowledge base: a live is filed under 直播, a post under 博主. */
const KIND_FOLDERS: Record<ContentKind, string> = { blogger: '博主', live: '直播' };
/** Plain scalars must not contain `:`/`#`/quotes/flow punctuation or start with one. */
const PLAIN_SAFE = /^[\p{L}\p{N}][\p{L}\p{N} .,\-_+/@()（）!?，。、；！？]*$/u;
/** `published` stays a YAML date when the API sends one, exactly as note frontmatter does. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export interface ContentReport {
	imported: number;
	skipped: number;
	failed: Array<{ title: string; error: string }>;
}

/** One blogger post or live session, identified before its detail is fetched. */
interface ContentTarget {
	kind: ContentKind;
	postId: string;
	ownerName: string;
}

/** Shared state of one bulk run: the topic it walks, the journal, and its report. */
interface ImportRun {
	topicId: string;
	topicName: string;
	journal: Map<string, string>;
	report: ContentReport;
	onProgress?: (message: string) => void;
}

/** Human readable error text; `request_id` is appended when the API sent one. */
function failureMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return error instanceof GetNoteApiError && error.requestId.length > 0
		? `${message}（request_id: ${error.requestId}）`
		: message;
}

/** Journal values are `"<vaultPath>|<publishTime>"`; the path may itself contain `|`. */
function splitContentMarker(marker: string): { path: string; published: string } {
	const separator = marker.lastIndexOf(MARKER_SEPARATOR);
	if (separator < 0) return { path: marker, published: '' };
	return { path: marker.slice(0, separator), published: marker.slice(separator + 1) };
}

/** Frontmatter value of a cloud field: quoted unless it is a plain, unambiguous scalar. */
function frontmatterValue(value: string): string {
	const flattened = value.replace(/\r?\n/g, ' ').trim();
	if (flattened.length === 0) return '""';
	if (ISO_TIMESTAMP.test(flattened)) return flattened;
	if (PLAIN_SAFE.test(flattened)) return flattened;
	return `"${flattened.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * `<content folder>/<知识库名>/<博主|直播>/<标题>-<postId>.md`.
 *
 * Every name that comes from the cloud goes through `sanitiseFileName`: titles
 * carry emoji, slashes and question marks, none of which the vault accepts. The
 * settings folder is a user-owned path (like `targetFolder`), so its own
 * segments stay exactly as typed.
 */
function contentFilePath(entry: ContentEntry, settings: GetNoteChannelSettings): string {
	const title = sanitiseFileName(entry.title) || UNTITLED_CONTENT;
	const postId = sanitiseFileName(entry.postId, MAX_ID_LENGTH);
	const fileName = postId.length > 0 ? `${title}-${postId}${MARKDOWN_EXTENSION}` : `${title}${MARKDOWN_EXTENSION}`;
	return joinVaultPath(
		settings.content.folder.trim() || DEFAULT_FOLDER,
		sanitiseFileName(entry.topicName),
		KIND_FOLDERS[entry.kind],
		fileName,
	);
}

/**
 * Frontmatter + body of one imported item.
 *
 * `uid` is quoted because a snowflake id written bare would be parsed as a YAML
 * number and lose its low digits, exactly the corruption the string-id rule
 * exists to prevent. The `readonly: true` line is hard-coded: nothing in this
 * plugin uploads an imported post, and the file should say so.
 */
function renderContentMarkdown(entry: ContentEntry): string {
	const lines: string[] = [
		'---',
		`uid: "${entry.postId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
		`kind: ${entry.kind}`,
		`topic: ${frontmatterValue(entry.topicName)}`,
	];
	if (entry.ownerName.trim().length > 0) lines.push(`owner: ${frontmatterValue(entry.ownerName)}`);
	lines.push(`published: ${frontmatterValue(entry.publishTime)}`, `source: ${frontmatterValue(entry.postUrl)}`);
	lines.push('---', '');
	lines.push('> 只读导入（readonly: true）：本文件由知识库内容同步生成，修改不会回传得到大脑。', '');
	// A stray `<!--` in imported text opens an HTML comment that would swallow the
	// rest of the file; render.ts defuses it the same way for note text.
	const summary = entry.summary.trim().split('<!--').join('<\\!--');
	const original = entry.mediaText.trim().split('<!--').join('<\\!--');
	if (summary.length > 0) lines.push('## 摘要', '', summary, '');
	if (original.length > 0) lines.push('## 原文', '', original, '');
	return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Knowledge base -> vault direction for the content the API keeps beside notes:
 * blogger posts and live sessions. Each track is gated by its own settings flag,
 * and a failure on one item never ends the run.
 */
export class ContentEngine {
	private readonly host: GetNotePluginHost;

	constructor(host: GetNotePluginHost) {
		this.host = host;
	}

	/** Imports every blogger post and live session of one knowledge base. */
	async importKnowledgeBaseContent(
		topicId: string,
		topicName: string,
		onProgress?: (message: string) => void,
	): Promise<ContentReport> {
		const run: ImportRun = {
			topicId,
			topicName,
			journal: this.rehydrateJournal(),
			report: { imported: 0, skipped: 0, failed: [] },
			onProgress,
		};
		const settings = this.host.getNoteSettings;
		if (settings.content.bloggers) await this.importBloggers(run);
		if (settings.content.lives) await this.importLives(run);
		await this.flush(run.journal);
		return run.report;
	}

	/** Single import used by the knowledge-base panel; returns the vault path. */
	async importPost(
		topicId: string,
		topicName: string,
		kind: ContentKind,
		postId: string,
		ownerName: string,
	): Promise<string> {
		const journal = this.rehydrateJournal();
		const result = await this.importEntry(topicId, topicName, { kind, postId, ownerName }, journal);
		await this.flush(journal);
		return result.path;
	}

	/** Working copy of the journal; the stored record is only touched by `flush`. */
	private rehydrateJournal(): Map<string, string> {
		const journal = new Map<string, string>();
		for (const [postId, marker] of Object.entries(this.host.getNoteSettings.contentIndex)) journal.set(postId, marker);
		return journal;
	}

	/** Writes the journal back in a single settings write, and only when it changed. */
	private async flush(journal: Map<string, string>): Promise<void> {
		const index = this.host.getNoteSettings.contentIndex;
		let changed = false;
		for (const [postId, marker] of journal) {
			if (index[postId] === marker) continue;
			index[postId] = marker;
			changed = true;
		}
		if (changed) await this.host.saveSettings();
	}

	private async importBloggers(run: ImportRun): Promise<void> {
		for (let page = 1; page <= MAX_PAGES; page++) {
			run.onProgress?.(`读取博主列表第 ${page} 页…`);
			let listing: { bloggers: KBBlogger[]; hasMore: boolean; total: number };
			try {
				listing = await this.host.endpoints.listBloggers(run.topicId, page);
			} catch (error) {
				// One failed listing ends its own track only: lives still import.
				this.record(run.report, `博主列表#${page}`, error);
				return;
			}
			for (const blogger of listing.bloggers) {
				// Without a follow id the content endpoint cannot be called at all.
				if (blogger.followId.length === 0) continue;
				await this.importBloggerPosts(run, blogger);
			}
			if (!listing.hasMore) return;
		}
	}

	private async importBloggerPosts(run: ImportRun, blogger: KBBlogger): Promise<void> {
		const label = blogger.accountName.trim() || blogger.followId;
		for (let page = 1; page <= MAX_PAGES; page++) {
			run.onProgress?.(`读取 ${label} 的内容第 ${page} 页…`);
			let listing: { posts: KBBloggerPost[]; hasMore: boolean; total: number };
			try {
				listing = await this.host.endpoints.listBloggerPosts(run.topicId, blogger.followId, page);
			} catch (error) {
				this.record(run.report, `${label} 内容#${page}`, error);
				return;
			}
			let fresh = 0;
			for (const post of listing.posts) {
				if (post.postId.length === 0) continue;
				fresh++;
				// The listing already carries `publish_time`, so an unchanged post is
				// settled from the journal alone and costs no detail request. The detail
				// stays the authority: a marker written by an older build (different time
				// format) falls through and is compared there.
				const marker = splitContentMarker(run.journal.get(post.postId) ?? '');
				if (marker.path.length > 0 && post.publishTime.length > 0 && post.publishTime === marker.published) {
					run.report.skipped++;
					continue;
				}
				await this.importOne(run, { kind: 'blogger', postId: post.postId, ownerName: blogger.accountName });
			}
			// A page that brings no usable id means the listing is exhausted, whatever
			// `has_more` claims.
			if (!listing.hasMore || fresh === 0) return;
		}
	}

	private async importLives(run: ImportRun): Promise<void> {
		for (let page = 1; page <= MAX_PAGES; page++) {
			run.onProgress?.(`读取直播列表第 ${page} 页…`);
			let listing: { lives: KBLive[]; hasMore: boolean; total: number };
			try {
				listing = await this.host.endpoints.listLives(run.topicId, page);
			} catch (error) {
				this.record(run.report, `直播列表#${page}`, error);
				return;
			}
			let fresh = 0;
			for (const live of listing.lives) {
				if (live.liveId.length === 0) continue;
				fresh++;
				// `knowledge/lives` returns no publish time, so the detail decides whether
				// the journaled copy is still current.
				await this.importOne(run, { kind: 'live', postId: live.liveId, ownerName: live.name });
			}
			if (!listing.hasMore || fresh === 0) return;
		}
	}

	/** One item of a bulk run: failures are reported, never thrown. */
	private async importOne(run: ImportRun, target: ContentTarget): Promise<void> {
		try {
			const result = await this.importEntry(run.topicId, run.topicName, target, run.journal, run.onProgress);
			if (result.written) run.report.imported++;
			else run.report.skipped++;
		} catch (error) {
			const title = target.ownerName.trim();
			this.record(run.report, title.length > 0 ? `${title} ${target.postId}` : target.postId, error);
		}
	}

	/**
	 * Detail -> markdown -> file, plus the journal update. A marker that still
	 * matches the item's publish time means the file is current: the write is
	 * skipped and the journaled path is returned untouched.
	 */
	private async importEntry(
		topicId: string,
		topicName: string,
		target: ContentTarget,
		journal: Map<string, string>,
		onProgress?: (message: string) => void,
	): Promise<{ path: string; written: boolean }> {
		const detail =
			target.kind === 'live'
				? await this.host.endpoints.getLive(topicId, target.postId)
				: await this.host.endpoints.getBloggerPost(topicId, target.postId);
		const entry: ContentEntry = {
			kind: target.kind,
			postId: detail.postId.length > 0 ? detail.postId : target.postId,
			topicId,
			topicName,
			// A live detail carries the session name in `post_name`, so an empty
			// `ownerName` still renders an `owner` line when the cloud knows one.
			ownerName: target.ownerName.trim() || detail.ownerName.trim(),
			title: detail.title.trim() || detail.ownerName.trim() || target.postId,
			subtitle: detail.subtitle.trim(),
			summary: detail.summary,
			mediaText: detail.mediaText,
			postUrl: detail.postUrl.trim(),
			publishTime: detail.publishTime.trim(),
		};
		const marker = splitContentMarker(journal.get(entry.postId) ?? '');
		if (marker.path.length > 0 && marker.published === entry.publishTime) {
			onProgress?.(`无变化：${entry.title}`);
			return { path: marker.path, written: false };
		}
		const markdown = renderContentMarkdown(entry);
		// The journaled file wins over the derived path, so a renamed folder does not
		// leave a duplicate behind (same resolution order as `PullEngine`).
		const journaled = marker.path.length > 0 ? this.host.app.vault.getAbstractFileByPath(marker.path) : null;
		const path = journaled instanceof TFile ? journaled.path : contentFilePath(entry, this.host.getNoteSettings);
		const existing = this.host.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) await this.host.app.vault.modify(existing, markdown);
		else {
			await this.ensureFolder(path);
			await this.host.app.vault.create(path, markdown);
		}
		journal.set(entry.postId, `${path}${MARKER_SEPARATOR}${entry.publishTime}`);
		onProgress?.(`导入${KIND_FOLDERS[entry.kind]}：${entry.title}`);
		return { path, written: true };
	}

	private record(report: ContentReport, title: string, error: unknown): void {
		report.failed.push({ title, error: failureMessage(error) });
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
}
