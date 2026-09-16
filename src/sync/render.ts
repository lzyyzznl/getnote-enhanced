/**
 * Markdown renderer for the GetNote (得到大脑 / Get笔记) channel.
 *
 * Everything emitted here becomes vault content the user keeps, so the layout
 * is a contract: note paths, frontmatter keys and section headings stay stable
 * across re-syncs.
 *
 * Structure of a rendered note:
 *
 *   ---                     frontmatter (uid first: `readFrontmatterUid` reads it)
 *   ---
 *
 *   > refContent blockquote              <- cloud-owned quote, read-only
 *   <!-- getnote:content:start -->
 *   note body                             <- the ONLY writable/pushable region
 *   <!-- getnote:content:end -->
 *
 *   ## 原文 / ## 转写 / ...               <- derived, read-only, deep-content gated
 *
 * Mobile-safe: no Node imports, only `obsidian` (for `normalizePath`).
 */

import { normalizePath } from 'obsidian';

import { webBaseFor } from '../api/client';
import {
	CONTENT_END,
	CONTENT_START,
	GetNoteChannelSettings,
	Note,
	UID_FIELD,
} from '../types';

export interface RenderContext {
	settings: GetNoteChannelSettings;
	/** remote attachment url -> vault-relative path already written */
	attachmentPaths: Map<string, string>;
	/** remote note id -> vault link target (vault-relative path without .md) */
	localLinks: Map<string, string>;
}

type AttachmentKind = 'image' | 'audio' | 'video' | 'document';

const UNTITLED_NOTE = '未命名笔记';
const UNCATEGORISED_FOLDER = '未分类';
const ATTACHMENT_FALLBACK_NAME = 'attachment';
const MAX_NAME_LENGTH = 80;
const MAX_ID_LENGTH = 64;

/** `note_type` -> readable folder name for `folderLayout: 'by-type'`. */
const NOTE_TYPE_FOLDERS: Record<string, string> = {
	plain_text: '纯文本',
	link: '链接',
	img_text: '图片',
	recorder: '录音卡',
	meeting: '会议',
	audio: '录音',
};

/** The extension both decides the download and picks the embed syntax. */
const ATTACHMENT_KINDS: Record<string, AttachmentKind> = {
	jpg: 'image',
	jpeg: 'image',
	png: 'image',
	gif: 'image',
	webp: 'image',
	heic: 'image',
	bmp: 'image',
	svg: 'image',
	avif: 'image',
	mp3: 'audio',
	m4a: 'audio',
	wav: 'audio',
	aac: 'audio',
	ogg: 'audio',
	flac: 'audio',
	amr: 'audio',
	mp4: 'video',
	mov: 'video',
	avi: 'video',
	mkv: 'video',
	webm: 'video',
	m4v: 'video',
	pdf: 'document',
	doc: 'document',
	docx: 'document',
	ppt: 'document',
	pptx: 'document',
	xls: 'document',
	xlsx: 'document',
	txt: 'document',
	md: 'document',
	csv: 'document',
	epub: 'document',
};

/**
 * Placeholder extension for signed CDN urls such as `…/voice?token=…`, which
 * carry neither a file name nor an extension; the real format is unknown, so the
 * attachment kind decides the most usable one.
 */
const EXTENSION_BY_KIND: Record<AttachmentKind, string> = {
	image: 'png',
	audio: 'mp3',
	video: 'mp4',
	document: 'pdf',
};

const INVALID_FILE_CHARS = /[\\/:*?"<>|]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const EDGE_DOTS = /^[.\s]+|[.\s]+$/g;
const BIJI_NOTE_URL = /https?:\/\/(?:www\.)?biji\.com\/note\/(\d+)/g;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** Plain scalars must not contain `:`/`#`/quotes/flow punctuation or start with one. */
const YAML_PLAIN_SAFE = /^[\p{L}\p{N}][\p{L}\p{N} .,\-_+/@()（）!?，。、；：！？]*$/u;
const YAML_AMBIGUOUS = /^(?:[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|yes|no|on|off|null|~)$/i;
const FRONTMATTER_OPEN = /^---[ \t]*\r?\n/;
const UID_LINE = new RegExp(`^\\s*${UID_FIELD}\\s*:\\s*(.*)$`);

/** `targetFolder/subfolder/file.md`; empty segments fall away, vault root stays relative. */
export function joinVaultPath(...segments: string[]): string {
	const parts = segments
		.map((segment) => segment.replace(/\\/g, '/').trim())
		.filter((segment) => segment.length > 0 && segment !== '.')
		.map((segment) => segment.replace(/^\/+|\/+$/g, ''));
	const joined = parts.join('/');
	return joined ? normalizePath(joined) : '';
}

/**
 * Strips characters Obsidian/vault file systems reject, then caps the length.
 * Whitespace collapses after the strip so removals do not leave double spaces,
 * and newlines become spaces instead of gluing words together.
 */
export function sanitiseFileName(raw: string, maxLength = MAX_NAME_LENGTH): string {
	const cleaned = raw
		.replace(INVALID_FILE_CHARS, '')
		.replace(/\s+/g, ' ')
		.replace(CONTROL_CHARS, '')
		.trim()
		.replace(EDGE_DOTS, '');
	return Array.from(cleaned).slice(0, maxLength).join('').trim();
}

function parseTimestamp(value: string): Date | null {
	if (!value) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Subfolder implied by `folderLayout`; `flat` and unknown layouts yield the root. */
function layoutFolder(note: Note, layout: GetNoteChannelSettings['folderLayout']): string {
	if (layout === 'by-type') {
		return sanitiseFileName(NOTE_TYPE_FOLDERS[note.noteType] ?? note.noteType) || UNCATEGORISED_FOLDER;
	}
	if (layout === 'by-date') {
		const date = parseTimestamp(note.createdAt) ?? parseTimestamp(note.updatedAt) ?? new Date();
		return `${date.getFullYear()}/${(date.getMonth() + 1).toString().padStart(2, '0')}`;
	}
	return '';
}

/**
 * Vault-relative path of the note file, `…/标题-<noteId>.md`. The id suffix keeps
 * the path unique and stable, so re-syncs hit the same file even after retitling.
 */
export function buildNotePath(note: Note, settings: GetNoteChannelSettings): string {
	const title = sanitiseFileName(note.title) || UNTITLED_NOTE;
	const noteId = sanitiseFileName(note.noteId, MAX_ID_LENGTH);
	const fileName = noteId ? `${title}-${noteId}.md` : `${title}.md`;
	return joinVaultPath(settings.targetFolder, layoutFolder(note, settings.folderLayout), fileName);
}

/**
 * YAML value that survives a round-trip: timestamps stay dates, everything risky
 * is quoted. Line breaks are escaped — a raw newline inside a quoted scalar would
 * let a title split the frontmatter block that `readFrontmatterUid` scans.
 */
function yamlScalar(value: string): string {
	const trimmed = value.trim();
	if (trimmed === '') return '""';
	if (ISO_TIMESTAMP.test(trimmed)) return trimmed;
	if (YAML_PLAIN_SAFE.test(trimmed) && !YAML_AMBIGUOUS.test(trimmed)) return trimmed;
	const quoted = trimmed
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\r?\n/g, '\\n');
	return `"${quoted}"`;
}

function buildFrontmatter(note: Note, settings: GetNoteChannelSettings): string {
	const lines: string[] = [];
	if (note.noteId) lines.push(`${UID_FIELD}: ${yamlScalar(note.noteId)}`);
	if (note.title.trim()) lines.push(`title: ${yamlScalar(note.title)}`);
	if (note.noteType.trim()) lines.push(`note_type: ${yamlScalar(note.noteType)}`);
	if (note.createdAt.trim()) lines.push(`created: ${yamlScalar(note.createdAt)}`);
	if (note.updatedAt.trim()) lines.push(`modified: ${yamlScalar(note.updatedAt)}`);

	const tags = [...new Set(note.tags.map((tag) => tag.name.trim()).filter((name) => name.length > 0))];
	if (tags.length > 0) {
		lines.push('tags:');
		for (const tag of tags) lines.push(`  - ${yamlScalar(tag)}`);
	}

	const webBase = webBaseFor(settings.apiBase, settings.webBase);
	lines.push(`source: ${yamlScalar(note.noteId ? `${webBase}/note/${note.noteId}` : webBase)}`);
	const externalUrl = (note.webPage?.url ?? '').trim();
	if (externalUrl) lines.push(`url: ${yamlScalar(externalUrl)}`);
	const topic = (note.topics[0]?.name ?? '').trim();
	if (topic) lines.push(`topic: ${yamlScalar(topic)}`);

	return ['---', ...lines, '---'].join('\n');
}

/** Rewrites `https://…biji.com/note/<id>` into a wikilink when the note is local. */
function localiseNoteLinks(text: string, context: RenderContext): string {
	if (!context.settings.linkToLocalNotes || !text.includes('biji.com')) return text;
	return text.replace(BIJI_NOTE_URL, (match, noteId: string) => {
		const target = context.localLinks.get(noteId);
		return target ? `[[${target}]]` : match;
	});
}

/**
 * Note text as it will appear in the file: links localised, and a stray `<!--`
 * defused — it would otherwise open an HTML comment and swallow the region
 * markers. `\!` renders as `!`, so the sentence still reads correctly.
 */
function prepareText(text: string, context: RenderContext): string {
	if (!text) return '';
	return localiseNoteLinks(text, context).split('<!--').join('<\\!--');
}

/** Whitespace-insensitive containment, used to avoid rendering the same text twice. */
function containsText(haystack: string, needle: string): boolean {
	const collapsed = needle.replace(/\s+/g, ' ').trim();
	if (!collapsed) return false;
	return haystack.replace(/\s+/g, ' ').includes(collapsed);
}

/** Original wording of a note, best source first (used when `deepContent.summary` is off). */
function originalText(note: Note): string {
	return (
		note.webPage?.content ||
		note.audio?.original ||
		note.refContent ||
		note.webPage?.excerpt ||
		note.quickNote ||
		''
	);
}

/**
 * The writable region: the AI summary, or the original text when summaries are
 * switched off. This is the only text a push-back uploads.
 */
function buildWritableBody(note: Note, context: RenderContext): string {
	const summary = context.settings.deepContent.summary ? prepareText(note.content, context).trim() : '';
	return summary || prepareText(originalText(note), context).trim();
}

/**
 * `ref_content` is cloud-owned quote data, so it renders ABOVE the writable
 * region: rendering it inside would make every push-back re-upload the quote as
 * the note's own content (the leak upstream had to patch in 3.8.0).
 */
function buildReferenceBlock(note: Note, context: RenderContext, body: string): string {
	const reference = prepareText(note.refContent, context).trim();
	if (reference.length === 0 || containsText(body, reference)) return '';
	return reference
		.split(/\r?\n/)
		.map((line) => (line.trim() ? `> ${line}` : '>'))
		.join('\n');
}

function formatClock(milliseconds: number): string {
	const total = Math.max(0, Math.floor(milliseconds / 1000));
	const seconds = (total % 60).toString().padStart(2, '0');
	const hours = Math.floor(total / 3600);
	if (hours > 0) return `${hours}:${(Math.floor(total / 60) % 60).toString().padStart(2, '0')}:${seconds}`;
	return `${Math.floor(total / 60).toString().padStart(2, '0')}:${seconds}`;
}

/** `attachment.type` is coarser than an extension, so its aliases map to the same kinds. */
const KIND_BY_ATTACHMENT_TYPE: Record<string, AttachmentKind> = {
	image: 'image',
	pic: 'image',
	photo: 'image',
	audio: 'audio',
	voice: 'audio',
	sound: 'audio',
	video: 'video',
	file: 'document',
	document: 'document',
	attachment: 'document',
};

function classifyAttachmentType(type: string): AttachmentKind | null {
	const key = type.trim().toLowerCase().split('/')[0];
	return key ? KIND_BY_ATTACHMENT_TYPE[key] ?? null : null;
}

/** File name part of a remote url; query strings and CDN processing suffixes are dropped. */
function remoteBaseName(remoteUrl: string): string {
	const path = remoteUrl.split(/[?#]/)[0].replace(/\\/g, '/');
	const name = path.slice(path.lastIndexOf('/') + 1);
	try {
		return decodeURIComponent(name).trim();
	} catch {
		// Malformed percent escapes are kept verbatim rather than failing the sync.
		return name.trim();
	}
}

/**
 * Extension as written in the url or file name, with query strings and CDN
 * suffixes dropped: `…/x.JPG?x-oss-process=image/resize` yields `JPG` (callers
 * compare case-insensitively so the on-disk name keeps the original casing).
 */
function remoteExtension(remoteUrl: string): string {
	const name = remoteBaseName(remoteUrl);
	const dot = name.lastIndexOf('.');
	if (dot <= 0 || dot === name.length - 1) return '';
	const extension = name.slice(dot + 1);
	return /^[a-z0-9]+$/i.test(extension) ? extension : '';
}

function classifyAttachmentUrl(remoteUrl: string): AttachmentKind | null {
	const extension = remoteExtension(remoteUrl).toLowerCase();
	return extension ? ATTACHMENT_KINDS[extension] ?? null : null;
}

function attachmentFileName(note: Note, remoteUrl: string): string {
	const attachment = note.attachments.find((item) => (item.url ?? '').trim() === remoteUrl);
	const named = (attachment?.name ?? '').trim();
	const source = remoteBaseName(remoteUrl) || named;
	const dot = source.lastIndexOf('.');
	const stem = sanitiseFileName(dot > 0 ? source.slice(0, dot) : source) ||
		sanitiseFileName(attachment?.type ?? '') ||
		ATTACHMENT_FALLBACK_NAME;
	const kind = classifyAttachmentUrl(remoteUrl) ?? classifyAttachmentType(attachment?.type ?? '');
	const extension = remoteExtension(remoteUrl) || remoteExtension(named) || (kind ? EXTENSION_BY_KIND[kind] : '');
	return extension ? `${stem}.${extension}` : stem;
}

/**
 * Vault-relative destination of a remote attachment:
 * `<attachmentFolder>/<noteId>/<file>`, where `attachmentFolder` is vault-absolute
 * when it starts with `/` and otherwise resolves below `targetFolder`.
 */
export function attachmentTargetPath(note: Note, remoteUrl: string, settings: GetNoteChannelSettings): string {
	const folder = settings.attachmentFolder.trim();
	const base = folder.startsWith('/') ? folder.replace(/^\/+/, '') : joinVaultPath(settings.targetFolder, folder);
	return joinVaultPath(base, sanitiseFileName(note.noteId, MAX_ID_LENGTH), attachmentFileName(note, remoteUrl));
}

/** Unknown extensions are never downloaded; the kind must also be enabled in settings. */
export function shouldDownloadAttachment(remoteUrl: string, settings: GetNoteChannelSettings): boolean {
	const kind = classifyAttachmentUrl(remoteUrl);
	return kind !== null && settings.attachmentTypes[kind];
}

/** Derived, read-only sections below the writable region; each is gated and never empty. */
function buildSections(note: Note, context: RenderContext, body: string): string[] {
	const deep = context.settings.deepContent;
	const sections: string[] = [];

	if (deep.linkOriginal) {
		const original = prepareText(note.webPage?.content ?? '', context).trim();
		if (original && !containsText(body, original)) sections.push(`## 原文\n\n${original}`);
	}

	if (deep.transcript) {
		const transcript = prepareText(note.audio?.original ?? '', context).trim();
		const playUrl = (note.audio?.playUrl ?? '').trim();
		const parts: string[] = [];
		if (playUrl) parts.push(`[播放录音](${playUrl})`);
		if (transcript && !containsText(body, transcript)) parts.push(transcript);
		if (parts.length > 0) sections.push(`## 转写\n\n${parts.join('\n\n')}`);
	}

	if (deep.timeline) {
		const moments = (note.timeline?.moments ?? []).filter((moment) => (moment.text ?? '').trim().length > 0);
		if (moments.length > 0) {
			const timed = moments.every((moment) => Number.isFinite(moment.startMs) && moment.startMs >= 0);
			const lines = moments.map((moment) => {
				const text = prepareText(moment.text, context).trim();
				return timed ? `- \`${formatClock(moment.startMs)}\` ${text}` : `- ${text}`;
			});
			sections.push(`## 时间线\n\n${lines.join('\n')}`);
		}
	}

	if (deep.meetingTodos) {
		const items = (note.meetingTodos?.items ?? []).filter((item) => (item.text ?? '').trim().length > 0);
		if (items.length > 0) {
			const lines = items.map(
				(item) => `- [${item.completed ? 'x' : ' '}] ${prepareText(item.text, context).trim()}`,
			);
			sections.push(`## 会议待办\n\n${lines.join('\n')}`);
		}
	}

	if (deep.quickNote) {
		const quickNote = prepareText(note.quickNote, context).trim();
		if (quickNote) sections.push(`## 快捷笔记\n\n${quickNote}`);
	}

	if (deep.attachments) {
		const lines: string[] = [];
		for (const attachment of note.attachments) {
			const url = (attachment.url ?? '').trim();
			if (!url) continue;
			const target = context.attachmentPaths.get(url);
			if (target) {
				const kind = classifyAttachmentUrl(url) ?? classifyAttachmentType(attachment.type ?? '');
				lines.push(kind === 'image' || kind === 'audio' ? `![[${target}]]` : `[[${target}]]`);
			} else {
				// Remote fallback: square brackets in the label would break the link text.
				const label = (attachment.name ?? '').replace(/\s+/g, ' ').trim() || remoteBaseName(url) || url;
				lines.push(`[${label.replace(/[[\]]/g, '\\$&')}](${url})`);
			}
		}
		if (lines.length > 0) sections.push(`## 附件\n\n${lines.join('\n')}`);
	}

	const children = [...new Set(note.childrenIds)];
	const links = children.map((childId) => context.localLinks.get(childId)).filter((link) => !!link);
	if (links.length > 0) sections.push(`## 子笔记\n\n${links.map((link) => `- [[${link}]]`).join('\n')}`);

	return sections;
}

/** Full markdown of a note: frontmatter, writable region, derived sections. */
export function renderNoteMarkdown(note: Note, context: RenderContext): string {
	const body = buildWritableBody(note, context);
	const parts: string[] = [buildFrontmatter(note, context.settings)];
	const reference = buildReferenceBlock(note, context, body);
	if (reference.length > 0) parts.push(reference);
	parts.push(body ? `${CONTENT_START}\n\n${body}\n\n${CONTENT_END}` : `${CONTENT_START}\n${CONTENT_END}`);
	parts.push(...buildSections(note, context, body));
	return `${parts.join('\n\n')}\n`;
}

/** Strips blank lines at the edges, keeping the body's own line breaks intact. */
function trimBlankLines(text: string): string {
	return text.replace(/^(?:[^\S\n]*\r?\n)+/, '').replace(/(?:\r?\n[^\S\n]*)+$/, '');
}

/** Index just past the closing `---` of a leading frontmatter block, or 0 when absent. */
function frontmatterEnd(markdown: string): number {
	const open = FRONTMATTER_OPEN.exec(markdown);
	if (!open) return 0;
	let index = open[0].length;
	while (index < markdown.length) {
		const lineEnd = markdown.indexOf('\n', index);
		if (lineEnd < 0) return 0;
		const line = markdown.slice(index, lineEnd).trim();
		index = lineEnd + 1;
		if (line === '---' || line === '...') return index;
	}
	return 0;
}

/**
 * Body of the note, i.e. what push-back uploads.
 *
 * - markers present: the text between the first `CONTENT_START`/`CONTENT_END`
 *   pair, blank edges trimmed;
 * - markers absent (files written before the marker contract): the whole file
 *   minus the leading frontmatter block, so legacy notes round-trip unchanged.
 */
export function extractWritableBody(markdown: string): string {
	const start = markdown.indexOf(CONTENT_START);
	if (start >= 0) {
		const end = markdown.indexOf(CONTENT_END, start + CONTENT_START.length);
		if (end > start) return trimBlankLines(markdown.slice(start + CONTENT_START.length, end));
	}
	return trimBlankLines(markdown.slice(frontmatterEnd(markdown)));
}

/**
 * Swaps the writable region, keeping every other byte untouched.
 *
 * When no marker pair exists the file is left exactly as it is and the markers
 * (carrying `body`) are appended, so migrating a legacy file never destroys the
 * text the user already has.
 */
export function replaceWritableBody(markdown: string, body: string): string {
	const block = body ? `${CONTENT_START}\n\n${body}\n\n${CONTENT_END}` : `${CONTENT_START}\n${CONTENT_END}`;
	const start = markdown.indexOf(CONTENT_START);
	const end = start < 0 ? -1 : markdown.indexOf(CONTENT_END, start + CONTENT_START.length);
	if (start >= 0 && end > start) {
		return `${markdown.slice(0, start)}${block}${markdown.slice(end + CONTENT_END.length)}`;
	}
	if (!markdown) return `${block}\n`;
	const separator = markdown.endsWith('\n\n') ? '' : markdown.endsWith('\n') ? '\n' : '\n\n';
	return `${markdown}${separator}${block}\n`;
}

/** `uid` from the leading frontmatter block; `''` when the note was never pushed. */
export function readFrontmatterUid(markdown: string): string {
	const end = frontmatterEnd(markdown);
	if (!end) return '';
	for (const rawLine of markdown.slice(0, end).split('\n')) {
		const match = UID_LINE.exec(rawLine.replace(/\r$/, ''));
		if (!match) continue;
		const value = match[1].trim();
		const quoted = /^(['"])(.*)\1$/.exec(value);
		if (quoted) return quoted[2];
		return value.replace(/[ \t]+#.*$/, '').trim();
	}
	return '';
}
