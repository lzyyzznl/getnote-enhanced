import { App, normalizePath, TFile } from 'obsidian';

import { GetNoteApiError, pause } from '../api/client';
import { GetNotePluginHost } from '../host';
import { GetNoteChannelSettings, UID_FIELD } from '../types';
import { extractWritableBody, readFrontmatterUid } from './render';

/** `note/update` accepts a tag list; the channel caps it so a runaway file cannot flood the API. */
const MAX_TAGS = 20;
/** `note/save` answers with a task for asynchronous note types; the task is polled. */
const TASK_POLL_INTERVAL_MS = 3000;
const TASK_POLL_ATTEMPTS = 20;

/**
 * Matches the `uid` value on its own frontmatter line. `[^\r\n]*` keeps the line
 * ending out of the match, so replacing the match leaves the file byte-identical
 * apart from the value itself.
 */
const UID_LINE_PATTERN = new RegExp(`^([ \\t]*)${UID_FIELD}[ \\t]*:[^\\r\\n]*`, 'm');
const FRONTMATTER_PATTERN = /^(---\r?\n)([\s\S]*?)(\r?\n---)/;

/**
 * MIME type per extension the cloud stores. Membership also decides which local
 * embeds are worth uploading, so a vault file of any other type is left in the text.
 */
const IMAGE_MIME_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	heic: 'image/heic',
	bmp: 'image/bmp',
	svg: 'image/svg+xml',
	avif: 'image/avif',
};

/** `![[a.png]]` / `![[a.png|alt]]`: an alias or block anchor is not part of the target. */
const WIKI_EMBED_PATTERN = /!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
/** `![alt](a.png)`; the optional `<…>` wrapper and title are dropped. */
const MARKDOWN_EMBED_PATTERN = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
/** A hosted url already points at the image, so its markdown stays untouched. */
const REMOTE_TARGET_PATTERN = /^(?:https?:)?\/\//i;

/** `folder` empty means "every file"; otherwise the file must live below it. */
function isInsideFolder(filePath: string, folder: string): boolean {
	const prefix = folder.replace(/^\/+|\/+$/g, '');
	if (prefix.length === 0) return true;
	return filePath.startsWith(`${prefix}/`);
}

/** Index values are `"<vaultPath>|<updatedAt>"`; entries written before the marker existed hold a bare path. */
function readIndexPath(marker: string): string {
	const separator = marker.lastIndexOf('|');
	return separator < 0 ? marker : marker.slice(0, separator);
}

/** Reverse index lookup: the note id behind a vault path, or '' when it was never pulled. */
function findNoteIdByPath(settings: GetNoteChannelSettings, filePath: string): string {
	for (const [noteId, marker] of Object.entries(settings.index)) {
		if (readIndexPath(marker) === filePath) return noteId;
	}
	return '';
}

/** Snowflake ids must stay strings: YAML reads an unquoted digit run as a number and rounds it. */
function uidScalar(noteId: string): string {
	return /^\d+$/.test(noteId) ? `"${noteId}"` : noteId;
}

/**
 * Inserts or refreshes the `uid` frontmatter field and returns the new markdown.
 * Everything else — frontmatter order, spacing, body, trailing newline — is
 * copied verbatim; only the value token of the `uid` line is rewritten.
 */
function withUidFrontmatter(markdown: string, noteId: string): string {
	const line = `${UID_FIELD}: ${uidScalar(noteId)}`;
	const block = FRONTMATTER_PATTERN.exec(markdown);
	if (!block) return `---\n${line}\n---\n${markdown}`;
	const [whole, open, body, close] = block;
	const patchedBody = UID_LINE_PATTERN.test(body) ? body.replace(UID_LINE_PATTERN, `$1${line}`) : `${line}\n${body}`;
	return open + patchedBody + close + markdown.slice(whole.length);
}

/**
 * Raw scalar of a frontmatter key, read from the text instead of `metadataCache`:
 * YAML reads an unquoted snowflake id as a number and rounds it past 2^53, and a
 * rounded `parent` would address a note nobody owns.
 */
function readFrontmatterScalar(markdown: string, key: string): string {
	const block = FRONTMATTER_PATTERN.exec(markdown)?.[2] ?? '';
	if (block.length === 0) return '';
	const value = (new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.*)$`, 'm').exec(block)?.[1] ?? '').trim();
	const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
	if (quoted) return quoted[2].trim();
	return value.replace(/[ \t]+#.*$/, '').trim();
}

/** Frontmatter `url`, but only when it is a web address the cloud can fetch. */
function readLinkUrl(markdown: string): string {
	const value = readFrontmatterScalar(markdown, 'url');
	return /^https?:\/\/\S+$/i.test(value) ? value : '';
}

/** Frontmatter `parent` / `parent_id`; anything but a digit run is not a note id. */
function readParentId(markdown: string): string {
	const value = readFrontmatterScalar(markdown, 'parent') || readFrontmatterScalar(markdown, 'parent_id');
	return /^\d+$/.test(value) ? value : '';
}

/**
 * Pulled files are named `标题-<noteId>.md`, and the id suffix is not part of the
 * title: without stripping it a push-back retitles the cloud note to `标题-1893…`,
 * which the next pull would then suffix all over again.
 */
function noteTitle(file: TFile, uid: string): string {
	const suffix = `-${uid}`;
	if (uid.length > 0 && file.basename.length > suffix.length && file.basename.endsWith(suffix)) {
		return file.basename.slice(0, -suffix.length);
	}
	return file.basename;
}

/**
 * Idempotency key for `note/save`: identical content must yield the same key, so
 * a retried push collapses into one cloud note instead of a duplicate. FNV-1a is
 * computed here because `crypto.subtle` is not guaranteed in Obsidian's renderer;
 * `Math.imul` keeps the 32-bit prime product exact.
 */
function requestIdFor(filePath: string, body: string): string {
	const input = `${filePath}\n${body}`;
	let hash = 0x811c9dc5;
	for (let index = 0; index < input.length; index++) {
		hash = Math.imul(hash ^ input.charCodeAt(index), 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

/**
 * True when the cloud copy behind a local `uid` no longer exists.
 *
 * The API answers a deleted note with the generic `10000 / invalid_request` envelope,
 * so the message is the only distinguishing part — the reference CLI matches on it too.
 */
function isMissingNote(error: unknown): boolean {
	return error instanceof GetNoteApiError && error.message.includes('无法找到笔记');
}

/** MIME type of a vault image, or null for an extension the API cannot store. */
function imageMimeType(name: string): string | null {
	const dot = name.lastIndexOf('.');
	if (dot < 0) return null;
	return IMAGE_MIME_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** Embed targets of the body in first-appearance order, each listed once. */
function collectEmbedTargets(body: string): string[] {
	const targets: string[] = [];
	const patterns = [WIKI_EMBED_PATTERN, MARKDOWN_EMBED_PATTERN];
	for (const pattern of patterns) {
		for (const match of body.matchAll(pattern)) {
			const target = match[1].trim();
			if (target.length > 0 && !targets.includes(target)) targets.push(target);
		}
	}
	return targets;
}

/**
 * Vault file behind an embed target. Obsidian resolves wikilinks and relative
 * markdown links itself; the literal lookups additionally cover an image the
 * cache has not indexed yet, plus a path written relative to the note's folder.
 */
function resolveEmbedFile(app: App, target: string, sourcePath: string): TFile | null {
	const linked = app.metadataCache.getFirstLinkpathDest(target, sourcePath);
	if (linked instanceof TFile) return linked;
	const folder = sourcePath.slice(0, Math.max(0, sourcePath.lastIndexOf('/')));
	const candidates = folder.length > 0 ? [target, `${folder}/${target}`] : [target];
	for (const candidate of candidates) {
		const found = app.vault.getAbstractFileByPath(normalizePath(candidate));
		if (found instanceof TFile) return found;
	}
	return null;
}

/**
 * Local -> cloud direction.
 *
 * Only the writable region travels: everything below `CONTENT_END` (transcript,
 * timeline, attachment index, ...) is derived from the cloud copy and is
 * regenerated by the next pull, so pushing it back would be pointless churn.
 */
export class PushEngine {
	private readonly host: GetNotePluginHost;

	constructor(host: GetNotePluginHost) {
		this.host = host;
	}

	/**
	 * Creates a cloud note from a local file, or updates it when `uid` frontmatter exists.
	 * Refuses files the settings exclude, and files without a writable body.
	 *
	 * The pushed note type follows what the file is: a frontmatter `url` makes it a
	 * link note, local images in the body make it an image note, anything else is
	 * plain text.
	 */
	async pushFile(file: TFile): Promise<{ noteId: string; created: boolean; pending: boolean }> {
		const settings = this.host.getNoteSettings;
		if (!settings.pushEnabled) throw new Error('推送未启用：请在插件设置中开启「启用推送」。');
		const folder = settings.pushFolder.trim();
		if (folder.length > 0 && !isInsideFolder(file.path, folder)) {
			throw new Error(`文件不在推送文件夹「${folder}」内。`);
		}
		const markdown = await this.host.app.vault.read(file);
		if (markdown.trim().length === 0) throw new Error(`「${file.basename}」为空文件，未推送。`);
		const body = extractWritableBody(markdown);
		if (body.trim().length === 0) throw new Error(`「${file.basename}」正文为空，未推送。`);
		const tags = this.readTags(file);
		const uid = readFrontmatterUid(markdown);
		const title = noteTitle(file, uid);

		if (uid.length > 0) {
			// `updateNote` replaces the tag list, so an empty frontmatter list is
			// sent as "absent" to leave the cloud tags alone. It carries neither a
			// link nor image field, so an existing note only gets retitled and re-bodied.
			try {
				await this.host.endpoints.updateNote({
					noteId: uid,
					title,
					content: body,
					tags: tags.length > 0 ? tags : undefined,
				});
				return { noteId: uid, created: false, pending: false };
			} catch (error) {
				// The cloud note was deleted (from the plugin or the app) while the local
				// file kept its `uid`. Retrying the create with the same idempotency key
				// would be worse than useless: the server replays the original response
				// and hands back the very id that no longer exists, so the retry needs a
				// key that has never been used and the stale `uid` gets overwritten.
				if (!isMissingNote(error)) throw error;
				return await this.createNote(file, markdown, body, tags, title, `${requestIdFor(file.path, body)}-r${Date.now().toString(36)}`);
			}
		}

		return await this.createNote(file, markdown, body, tags, title, requestIdFor(file.path, body));
	}

	/**
	 * `note/save` for a file without a cloud note yet: the note type follows what the
	 * file is, and the idempotency key keeps a retried request from creating twins.
	 */
	private async createNote(
		file: TFile,
		markdown: string,
		body: string,
		tags: string[],
		title: string,
		clientRequestId: string,
	): Promise<{ noteId: string; created: boolean; pending: boolean }> {
		// `note/save` takes one payload per type, so a link note skips the uploads:
		// its text stays on the original page, and the body is not sent at all.
		const linkUrl = readLinkUrl(markdown);
		const imageUrls = linkUrl.length > 0 ? [] : await this.uploadBodyImages(file, body);
		const noteType: 'link' | 'img_text' | 'plain_text' =
			linkUrl.length > 0 ? 'link' : imageUrls.length > 0 ? 'img_text' : 'plain_text';
		const parentId = readParentId(markdown);
		const saved = await this.host.endpoints.saveNote({
			noteType,
			title,
			content: noteType === 'link' ? undefined : body,
			linkUrl: linkUrl.length > 0 ? linkUrl : undefined,
			imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
			tags: tags.length > 0 ? tags : undefined,
			parentId: parentId.length > 0 ? parentId : undefined,
			clientRequestId,
		});
		let noteId = saved.noteId;
		if (saved.pending) noteId = await this.awaitTask(saved.taskIds[0], file);
		await this.writeUid(file, noteId);
		return { noteId, created: true, pending: saved.pending };
	}

	/**
	 * Uploads every image the writable body embeds from the vault and answers with
	 * the public urls for `image_urls`. A failed upload aborts the push: saving the
	 * note without that image would silently drop content the text still shows.
	 */
	private async uploadBodyImages(file: TFile, body: string): Promise<string[]> {
		const urls: string[] = [];
		const uploaded: string[] = [];
		for (const target of collectEmbedTargets(body)) {
			if (REMOTE_TARGET_PATTERN.test(target)) continue;
			const image = resolveEmbedFile(this.host.app, target, file.path);
			if (!image) continue;
			const mimeType = imageMimeType(image.name);
			if (mimeType === null || uploaded.includes(image.path)) continue;
			uploaded.push(image.path);
			try {
				const bytes = await this.host.app.vault.readBinary(image);
				urls.push(await this.host.endpoints.uploadImage(bytes, image.name, mimeType));
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				throw new Error(`「${file.basename}」内嵌图片「${image.path}」上传失败：${reason}`);
			}
		}
		return urls;
	}

	/** Shares the cloud note behind a local file and returns its public url. */
	async shareFile(file: TFile): Promise<string> {
		const markdown = await this.host.app.vault.read(file);
		let noteId = readFrontmatterUid(markdown);
		if (noteId.length === 0) noteId = findNoteIdByPath(this.host.getNoteSettings, file.path);
		if (noteId.length === 0) throw new Error(`「${file.basename}」尚未关联云端笔记，请先执行推送。`);
		return this.host.endpoints.shareNote(noteId, false);
	}

	/**
	 * `link`/`img_text` saves answer with a task instead of a note id; poll until
	 * the note id resolves so the local file can be linked to it.
	 */
	private async awaitTask(taskId: string | undefined, file: TFile): Promise<string> {
		if (!taskId || taskId.length === 0) throw new Error(`「${file.basename}」保存任务缺少 ID，无法确认结果。`);
		for (let attempt = 0; attempt < TASK_POLL_ATTEMPTS; attempt++) {
			await pause(TASK_POLL_INTERVAL_MS);
			const progress = await this.host.endpoints.taskProgress(taskId);
			// A note id means the note exists even when the task is marked failed: for
			// image notes the part that fails is the cloud's own analysis (OCR /
			// description) on a file it cannot read, and reporting that as a failed push
			// would hide a note that is already there.
			if (progress.noteId.length > 0) return progress.noteId;
			if (progress.status === 'failed') throw new Error(`「${file.basename}」云端处理失败。`);
		}
		throw new Error(`「${file.basename}」云端处理超时，请稍后在得到大脑中确认。`);
	}

	/** Re-reads before patching so an edit made during the API call is not lost. */
	private async writeUid(file: TFile, noteId: string): Promise<void> {
		const current = await this.host.app.vault.read(file);
		const patched = withUidFrontmatter(current, noteId);
		if (patched !== current) await this.host.app.vault.modify(file, patched);
	}

	/** Frontmatter `tags`, strings only, deduplicated and capped; `metadataCache` parses the YAML. */
	private readTags(file: TFile): string[] {
		const raw: unknown = this.host.app.metadataCache.getFileCache?.(file)?.frontmatter?.tags;
		const source = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;]/) : [];
		const tags: string[] = [];
		for (const entry of source) {
			if (typeof entry !== 'string') continue;
			const tag = entry.trim().replace(/^#+/, '');
			if (tag.length === 0 || tags.includes(tag)) continue;
			tags.push(tag);
			if (tags.length >= MAX_TAGS) break;
		}
		return tags;
	}
}
