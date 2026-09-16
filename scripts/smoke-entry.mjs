/**
 * Headless end-to-end scenario for the GetNote channel.
 *
 * Bundled by `scripts/smoke.mjs` with `obsidian` aliased to the runtime stub, so
 * this file drives the real service without Obsidian running:
 *   auth -> quota -> note list -> note detail -> render -> pull (files +
 *   attachments) -> recall -> knowledge bases -> directories, and optionally the
 *   write path (push create -> push update -> tags -> share -> delete).
 *
 * Required env: GETNOTE_API_KEY, GETNOTE_CLIENT_ID, GETNOTE_SMOKE_VAULT.
 * Optional env: GETNOTE_SMOKE_WRITE=1 (exercise writes) and
 * GETNOTE_SMOKE_WRITE_DELETE=1 (move the created test notes to the trash).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { TFile, createVaultBackedApp, normalizePath } from 'obsidian';

import { ApiClient } from '../src/api/client';
import { GetNoteEndpoints } from '../src/api/endpoints';
import { PullEngine } from '../src/sync/pull';
import { PushEngine } from '../src/sync/push';
import { buildNotePath, extractWritableBody, renderNoteMarkdown } from '../src/sync/render';
import { defaultGetNoteSettings } from '../src/types';

const passed = [];
const failed = [];

function check(condition, step, detail) {
	if (condition) {
		passed.push({ step, detail });
		return;
	}
	failed.push(`${step} — ${detail}`);
}

function requireEnv(name) {
	const value = process.env[name];
	if (!value) throw new Error(`missing env ${name}`);
	return value;
}

function buildHost(vaultRoot) {
	const app = createVaultBackedApp(vaultRoot);
	const settings = {
		...defaultGetNoteSettings(),
		apiKey: requireEnv('GETNOTE_API_KEY'),
		clientId: requireEnv('GETNOTE_CLIENT_ID'),
		targetFolder: 'get',
		folderLayout: 'by-type',
	};
	const apiClient = new ApiClient(() => ({
		apiKey: settings.apiKey,
		clientId: settings.clientId,
		apiBase: settings.apiBase,
	}));
	const endpoints = new GetNoteEndpoints(apiClient);
	const host = {
		app,
		getNoteSettings: settings,
		apiClient,
		endpoints,
		async saveSettings() {
			await fs.writeFile(`${vaultRoot}/.smoke-settings.json`, JSON.stringify(settings, null, 2), 'utf8');
		},
		refreshCredentials() {
			apiClient.clearBlock();
		},
	};
	host.pull = new PullEngine(host);
	host.push = new PushEngine(host);
	return { host, app, settings, endpoints, pull: host.pull, push: host.push, apiClient };
}

/** Vault path the journal points at, or `null` when the note was never pulled. */
function pulledPath(settings, noteId) {
	const marker = settings.index[noteId];
	if (marker === undefined) return null;
	const separator = marker.lastIndexOf('|');
	return separator < 0 ? marker : marker.slice(0, separator);
}

async function readPulledFile({ app, settings, noteId }) {
	const vaultPath = pulledPath(settings, noteId);
	if (vaultPath === null) return '';
	const file = app.vault.getAbstractFileByPath(vaultPath);
	return file instanceof TFile ? await app.vault.read(file) : '';
}

/**
 * Every deep section is asserted against a real production payload: the newest
 * notes are scanned for the first one carrying each field. The scan costs one
 * `note/detail` per note, stops as soon as the four fields that carry data in
 * practice are covered, and reports what it could not find instead of passing.
 */
async function findDeepSamples(endpoints, maxPages = 2) {
	const samples = {};
	let cursor = '';
	let scanned = 0;
	for (let page = 1; page <= maxPages; page++) {
		const listing = await endpoints.listNotes({ cursor });
		for (const note of listing.notes) {
			scanned++;
			const detail = await endpoints.getNote(note.noteId);
			if (samples.linkOriginal === undefined && (detail.webPage?.content ?? '').length > 0) samples.linkOriginal = detail;
			if (samples.transcript === undefined && (detail.audio?.original ?? '').length > 0) samples.transcript = detail;
			if (samples.timeline === undefined && (detail.timeline?.moments ?? []).some((moment) => (moment.text ?? '').trim().length > 0)) samples.timeline = detail;
			if (samples.attachments === undefined && (detail.attachments ?? []).length > 0) samples.attachments = detail;
			if (samples.meetingTodos === undefined && (detail.meetingTodos?.items ?? []).length > 0) samples.meetingTodos = detail;
			if (samples.quickNote === undefined && (detail.quickNote ?? '').trim().length > 0) samples.quickNote = detail;
			if (['linkOriginal', 'transcript', 'timeline', 'attachments'].every((field) => samples[field] !== undefined)) {
				return { samples, scanned };
			}
		}
		if (!listing.hasMore || listing.cursor.length === 0) break;
		cursor = listing.cursor;
	}
	return { samples, scanned };
}

/** Asserts `## 原文` / `## 转写` / `## 时间线` / `## 附件` against real notes, not fixtures. */
async function exerciseDeepContent({ app, settings, pull, endpoints }) {
	const { samples, scanned } = await findDeepSamples(endpoints);
	const present = ['linkOriginal', 'transcript', 'timeline', 'meetingTodos', 'quickNote', 'attachments'].filter((field) => samples[field] !== undefined);
	passed.push({
		step: 'deep.samples',
		detail: `扫描 ${scanned} 条笔记，命中字段：${present.length > 0 ? present.join('/') : '无'}`,
	});

	if (samples.linkOriginal) {
		const note = samples.linkOriginal;
		await pull.syncNote(note.noteId);
		const markdown = await readPulledFile({ app, settings, noteId: note.noteId });
		check(markdown.includes('## 原文'), 'deep.linkOriginal', `《${note.title}》web_page.content ${note.webPage.content.length} 字已渲染`);
	}
	if (samples.transcript) {
		const note = samples.transcript;
		await pull.syncNote(note.noteId);
		const markdown = await readPulledFile({ app, settings, noteId: note.noteId });
		check(markdown.includes('## 转写'), 'deep.transcript', `《${note.title}》audio.original ${note.audio.original.length} 字已渲染`);
	}
	if (samples.timeline) {
		const note = samples.timeline;
		await pull.syncNote(note.noteId);
		const markdown = await readPulledFile({ app, settings, noteId: note.noteId });
		check(markdown.includes('## 时间线'), 'deep.timeline', `《${note.title}》timeline.moments ${note.timeline.moments.length} 个时刻已渲染`);
	}
	if (samples.attachments) {
		const note = samples.attachments;
		const report = await pull.syncNote(note.noteId);
		const markdown = await readPulledFile({ app, settings, noteId: note.noteId });
		const files = typeof app.vault.getFiles === 'function' ? app.vault.getFiles() : app.vault.getMarkdownFiles();
		const downloaded = files.filter((file) => file.path.includes(note.noteId));
		check(markdown.includes('## 附件') && downloaded.length > 0, 'deep.attachments', `《${note.title}》附件索引 ${note.attachments.length} 项，落盘 ${downloaded.length} 个（report.attachments=${report.attachments}）`);
	}
	const missing = ['linkOriginal', 'transcript', 'timeline', 'attachments', 'meetingTodos', 'quickNote'].filter((field) => samples[field] === undefined);
	if (missing.length > 0) {
		passed.push({ step: 'deep.noSample', detail: `账号内无可渲染样本：${missing.join('/')} —— 未对生产数据实测，仅合成 note 覆盖` });
	}

	// Sections without a production sample in the account still get their render
	// path exercised, on a synthetic payload, and are labelled as such.
	const syntheticDeep = renderNoteMarkdown(
		{
			noteId: '1900000000000000002',
			title: '深度区块合成样本',
			content: '合成正文',
			noteType: 'meeting',
			createdAt: '2026-09-16 10:00:00',
			updatedAt: '2026-09-16 10:00:00',
			tags: [],
			topics: [],
			source: '',
			entryType: '',
			shareId: '',
			childrenIds: [],
			childrenCount: 0,
			isChildNote: false,
			parentNoteId: '',
			attachments: [],
			webPage: { content: '合成链接原文' },
			audio: { original: '合成转写文本', playUrl: 'https://example.com/voice', duration: 60 },
			quickNote: '合成快捷笔记',
			timeline: { moments: [{ text: '合成时刻', startMs: 1000, endMs: 2000 }] },
			meetingTodos: { items: [{ text: '合成待办', completed: false }] },
		},
		{ settings: defaultGetNoteSettings(), attachmentPaths: new Map(), localLinks: new Map() },
	);
	const syntheticSections = ['## 原文', '## 转写', '## 时间线', '## 会议待办', '## 快捷笔记'].filter((section) => syntheticDeep.includes(section));
	check(syntheticSections.length === 5, 'render.deep.synthetic', `合成 note 渲染出 ${syntheticSections.length}/5 个深度区块：${syntheticSections.join(' ')}`);
}

/**
 * Takeover check: a file this channel already wrote, sitting at a path the
 * current path rules would not produce, must be adopted through its `uid`
 * instead of being duplicated at the derived path.
 */
async function exerciseAdoption({ app, settings, pull, endpoints, vaultRoot, sample }) {
	const note = await endpoints.getNote(sample.noteId);
	const legacyPath = normalizePath(`get/legacy-import/旧路径-${note.noteId}.md`);
	// Seeded through the vault API, exactly as a sync from an older build (or a
	// manual import) would have left it on disk.
	await app.vault.createFolder('get/legacy-import');
	await app.vault.create(
		legacyPath,
		`---\nuid: ${note.noteId}\nmodified: 2099-01-01 00:00:00\n---\n\n<!-- getnote:content:start -->\n本地正文：接管后必须保留\n<!-- getnote:content:end -->\n`,
	);

	const report = await pull.syncNote(note.noteId);
	const derivedPath = normalizePath(buildNotePath(note, settings));
	check(
		app.vault.getAbstractFileByPath(derivedPath) === null,
		'adopt.noDuplicate',
		`未在推导路径 ${derivedPath} 新建副本（created=${report.created} updated=${report.updated}）`,
	);
	const legacyText = await fs.readFile(path.join(vaultRoot, legacyPath), 'utf8').catch(() => '');
	check(legacyText.includes('本地正文：接管后必须保留'), 'adopt.localBodyKept', '旧路径文件的本地正文被保留');
	check(pulledPath(settings, note.noteId) === legacyPath, 'adopt.indexed', `日志已指向旧路径（${pulledPath(settings, note.noteId)}）`);
}

async function exerciseWritePath({ vaultRoot, endpoints, push }) {
	const draftVaultPath = 'get/push-test.md';
	const draftAbsolutePath = path.join(vaultRoot, draftVaultPath);
	await fs.mkdir(path.dirname(draftAbsolutePath), { recursive: true });
	await fs.writeFile(draftAbsolutePath, '# 推送验证草稿\n\n这是推送链路验证笔记，可安全删除。\n', 'utf8');

	const file = new TFile(draftVaultPath);
	const created = await push.pushFile(file);
	check(created.created && created.noteId.length > 0, 'push.create', `云端笔记 ${created.noteId}（pending=${created.pending}）`);

	const afterPush = await fs.readFile(draftAbsolutePath, 'utf8');
	check(afterPush.includes(created.noteId), 'push.uidWriteBack', '本地文件已写回 uid');

	const updated = await push.pushFile(file);
	check(updated.created === false && updated.noteId === created.noteId, 'push.update', `二次推送走更新路径（${updated.noteId}）`);

	await endpoints.addTags(created.noteId, ['自动化测试']);
	const withTags = await endpoints.getNote(created.noteId);
	check(withTags.tags.some((tag) => tag.name === '自动化测试'), 'tags.add', `标签 ${withTags.tags.map((tag) => tag.name).join('/')}`);

	const shareUrl = await endpoints.shareNote(created.noteId, true);
	check(shareUrl.startsWith('http'), 'share', shareUrl);

	const shared = await endpoints.shareNote(created.noteId, true);
	check(shared === shareUrl, 'share.idempotent', '重复调用返回同一链接');

	const direct = await endpoints.saveNote({ noteType: 'plain_text', title: '推送验证草稿（直存）', content: '同上' });
	check(direct.noteId.length > 0, 'save.plainText', `同步返回 ${direct.noteId}`);

	if (process.env.GETNOTE_SMOKE_WRITE_DELETE === '1') {
		for (const noteId of [created.noteId, direct.noteId]) await endpoints.deleteNote(noteId);
		check(true, 'delete', '测试笔记已移入回收站');
	}
}

async function main() {
	const vaultRoot = requireEnv('GETNOTE_SMOKE_VAULT');
	const { app, endpoints, pull, push, settings } = buildHost(vaultRoot);

	const quota = await endpoints.getQuota();
	check(quota !== null, 'quota', quota ? `读取剩余 ${quota.read.daily.remaining}/${quota.read.daily.limit}，写入剩余 ${quota.write.daily.remaining}/${quota.write.daily.limit}` : '未返回配额数据');

	const page = await endpoints.listNotes({});
	check(page.notes.length > 0, 'list', `第一页 ${page.notes.length} 条，hasMore=${page.hasMore}，total=${page.total}`);
	const sample = page.notes[0];
	check(/^\d{16,}$/.test(sample.noteId), 'list.id', `note_id 为字符串且未丢精度：${sample.noteId}`);

	const detail = await endpoints.getNote(sample.noteId);
	check(detail.noteId === sample.noteId, 'detail', `详情与列表一致（${detail.noteType}）`);

	// Runs before the first pull so the vault is still empty but for the seeded file.
	if (page.notes[1]) await exerciseAdoption({ app, settings, pull, endpoints, vaultRoot, sample: page.notes[1] });

	const report = await pull.syncNote(sample.noteId, (message) => passed.push({ step: 'pull.progress', detail: message }));
	check(report.created + report.updated === 1, 'pull.syncNote', `created=${report.created} updated=${report.updated} attachments=${report.attachments} failed=${report.failed.length}`);
	for (const failure of report.failed.slice(0, 4)) {
		passed.push({ step: 'pull.failed', detail: `${failure.title} — ${failure.error}` });
	}

	const markdownFiles = app.vault.getMarkdownFiles();
	check(markdownFiles.length >= 1, 'pull.file', markdownFiles.map((file) => file.path).join(', '));
	if (markdownFiles.length > 0) {
		const markdown = await app.vault.read(markdownFiles[0].path);
		check(markdown.includes('getnote:content:start'), 'render.marker', '文件包含可写区标记');
		check(/^uid:/m.test(markdown), 'render.frontmatter', '文件包含 uid 前置字段');
		check(await fs.stat(path.join(vaultRoot, markdownFiles[0].path)).then(() => true).catch(() => false), 'pull.fileExists', '文件已落盘');
	}

	const second = await pull.syncNote(sample.noteId);
	check(second.created === 0 && second.skipped === 1, 'pull.idempotent', `再次同步未改动（skipped=${second.skipped}，updated=${second.updated}）`);

	// Pure render check: the cloud-owned quote must stay OUTSIDE the writable region
	// so a push-back can never upload it as note content.
	const synthetic = {
		noteId: '1900000000000000001',
		title: '引用测试',
		content: '正文内容',
		noteType: 'plain_text',
		createdAt: '2026-09-16 10:00:00',
		updatedAt: '2026-09-16 10:00:00',
		tags: [],
		topics: [],
		refContent: '这段是云端引用',
		source: '',
		entryType: '',
		shareId: '',
		childrenIds: [],
		childrenCount: 0,
		isChildNote: false,
		parentNoteId: '',
		attachments: [],
	};
	const syntheticMarkdown = renderNoteMarkdown(synthetic, {
		settings: defaultGetNoteSettings(),
		attachmentPaths: new Map(),
		localLinks: new Map(),
	});
	const markerIndex = syntheticMarkdown.indexOf('getnote:content:start');
	check(syntheticMarkdown.indexOf('> 这段是云端引用') >= 0 && syntheticMarkdown.indexOf('> 这段是云端引用') < markerIndex, 'render.refOutsideWritable', '引用块渲染在可写区之外');
	check(extractWritableBody(syntheticMarkdown) === '正文内容', 'render.writableBody', `可写正文=${JSON.stringify(extractWritableBody(syntheticMarkdown))}`);

	const recall = await endpoints.recall('会议', 3);
	check(recall.length > 0, 'recall', `命中 ${recall.length} 条，首条《${recall[0]?.title ?? ''}》`);

	const topics = await endpoints.listKnowledgeBases();
	check(topics.length > 0, 'knowledgeBases', `${topics.length} 个知识库，首个「${topics[0]?.name ?? ''}」`);
	if (topics.length > 0) {
		const listing = await endpoints.listDirectory(topics[0].topicId);
		check(listing.currentDirectory !== null, 'directory', `当前目录「${listing.currentDirectory?.name ?? ''}」，${listing.resources.length} 个资源`);
	}

	await exerciseDeepContent({ app, settings, pull, endpoints });

	if (process.env.GETNOTE_SMOKE_WRITE === '1') {
		await exerciseWritePath({ vaultRoot, endpoints, push });
	} else {
		passed.push({ step: 'writePath', detail: 'skipped（未设置 GETNOTE_SMOKE_WRITE=1）' });
	}

	for (const entry of passed) console.log(`OK   ${entry.step.padEnd(20)} ${entry.detail}`);
	for (const failure of failed) console.error(`FAIL ${failure}`);
	console.log(`\n${passed.length} checks passed, ${failed.length} failed`);
	if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
	console.error('smoke run aborted:', error);
	process.exitCode = 1;
});
