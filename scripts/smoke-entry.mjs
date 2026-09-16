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
 * Optional env: GETNOTE_SMOKE_WRITE=1 (exercise writes), GETNOTE_SMOKE_WRITE_DELETE=1
 * (move the created test notes to the trash) and GETNOTE_SMOKE_IMAGE=<file> (exercise
 * the image upload + img_text note path; the uploaded image stays in the cloud).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { TFile, createVaultBackedApp, normalizePath } from 'obsidian';

import { ApiClient } from '../src/api/client';
import { GetNoteEndpoints } from '../src/api/endpoints';
import { ContentEngine } from '../src/sync/content';
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
		webBase: settings.webBase,
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
	host.content = new ContentEngine(host);
	return { host, app, settings, endpoints, pull: host.pull, push: host.push, content: host.content, apiClient };
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
	const persisted = JSON.parse(await fs.readFile(path.join(vaultRoot, '.smoke-settings.json'), 'utf8'));
	check(String(persisted.index?.[note.noteId] ?? '').startsWith(legacyPath), 'adopt.persisted', `落盘的设置文件同样指向旧路径（${persisted.index?.[note.noteId]}）`);
}

async function exerciseWritePath({ vaultRoot, app, endpoints, push, topic }) {
	// The idempotency key is derived from the path and body, so a fixed body would
	// replay the previous run's `note/save` response — including its note id, which
	// that run then deleted. A per-run marker keeps the create/update path honest.
	const runId = Date.now().toString(36);
	const draftVaultPath = 'get/push-test.md';
	const draftAbsolutePath = path.join(vaultRoot, draftVaultPath);
	await fs.mkdir(path.dirname(draftAbsolutePath), { recursive: true });
	await fs.writeFile(draftAbsolutePath, `# 推送验证草稿\n\n运行标记：${runId}\n\n这是推送链路验证笔记，可安全删除。\n`, 'utf8');

	const file = new TFile(draftVaultPath);
	const created = await push.pushFile(file);
	check(created.created && created.noteId.length > 0, 'push.create', `云端笔记 ${created.noteId}（pending=${created.pending}）`);

	const afterPush = await fs.readFile(draftAbsolutePath, 'utf8');
	check(afterPush.includes(created.noteId), 'push.uidWriteBack', '本地文件已写回 uid');

	const updated = await push.pushFile(file);
	check(updated.created === false && updated.noteId === created.noteId, 'push.update', `二次推送走更新路径（${updated.noteId}）`);

	// A `uid` whose cloud note was deleted must not be a dead end: the push has to
	// create a replacement under a fresh idempotency key and rewrite the stale uid.
	const doomed = await endpoints.saveNote({ noteType: 'plain_text', title: `复活验证 ${runId}`, content: `doomed ${runId}` });
	await endpoints.deleteNote(doomed.noteId);
	const reviveVaultPath = 'get/push-revive.md';
	await fs.writeFile(
		path.join(vaultRoot, reviveVaultPath),
		`---\nuid: "${doomed.noteId}"\n---\n\n复活推送验证 ${runId}，可删除。\n`,
		'utf8',
	);
	const revived = await push.pushFile(new TFile(reviveVaultPath));
	const revivedText = await fs.readFile(path.join(vaultRoot, reviveVaultPath), 'utf8');
	const revivedUidLine = /^uid:[^\r\n]*/m.exec(revivedText)?.[0] ?? '';
	check(
		revived.created && revived.noteId !== doomed.noteId && revivedUidLine.includes(revived.noteId),
		'push.revive',
		`被删笔记已重建（${doomed.noteId} → ${revived.noteId}，本地 uid 已更新）`,
	);

	// Link note: frontmatter `url` must produce noteType `link` instead of the
	// plain_text the create path used to hardcode.
	const linkVaultPath = 'get/push-link.md';
	await fs.writeFile(
		path.join(vaultRoot, linkVaultPath),
		'---\nurl: https://example.com/getnote-smoke\n---\n\n链接笔记推送验证，可删除。运行标记：' + runId + '\n',
		'utf8',
	);
	const linkPush = await push.pushFile(new TFile(linkVaultPath));
	const linkDetail = linkPush.noteId.length > 0 ? await endpoints.getNote(linkPush.noteId) : null;
	check(linkPush.created && linkDetail?.noteType === 'link', 'push.link', `链接笔记 ${linkPush.noteId}（type=${linkDetail?.noteType ?? '?'}）`);

	// Image note: an image embedded in the writable body is uploaded first and the
	// note is created as `img_text` with the returned URL. The image goes in through
	// the vault API (not plain fs) so link resolution can actually see it.
	const imageVaultPath = 'get/push-pic.png';
	const imageNotePath = 'get/push-pic.md';
	await app.vault.createBinary(imageVaultPath, Buffer.from(TINY_PNG_BASE64, 'base64'));
	await app.vault.create(imageNotePath, `图片笔记推送验证，可删除。运行标记：${runId}\n\n![[push-pic.png]]\n`);
	const imageFile = app.vault.getAbstractFileByPath(imageNotePath);
	const imagePush = await push.pushFile(imageFile);
	const imageDetail = imagePush.noteId.length > 0 ? await endpoints.getNote(imagePush.noteId) : null;
	check(
		imagePush.created && imageDetail?.noteType === 'img_text',
		'push.imgText',
		`图片笔记 ${imagePush.noteId}（type=${imageDetail?.noteType ?? '?'}）`,
	);

	await endpoints.addTags(created.noteId, ['自动化测试']);
	const withTags = await endpoints.getNote(created.noteId);
	check(withTags.tags.some((tag) => tag.name === '自动化测试'), 'tags.add', `标签 ${withTags.tags.map((tag) => tag.name).join('/')}`);

	const shareUrl = await endpoints.shareNote(created.noteId, true);
	check(shareUrl.startsWith('http'), 'share', shareUrl);

	const shared = await endpoints.shareNote(created.noteId, true);
	check(shared === shareUrl, 'share.idempotent', '重复调用返回同一链接');

	const addedTag = withTags.tags.find((tag) => tag.name === '自动化测试');
	if (addedTag) {
		await endpoints.deleteTag(created.noteId, addedTag.id);
		const withoutTag = await endpoints.getNote(created.noteId);
		check(
			!withoutTag.tags.some((tag) => tag.name === '自动化测试'),
			'tags.delete',
			`按 tag_id 删除已生效（${addedTag.id}）`,
		);
	}

	if (topic !== null) {
		const added = await endpoints.addNotesToKnowledgeBase(topic.topicId, [created.noteId]);
		check(added === 1, 'kb.noteAdd', `已加入知识库「${topic.name}」（${added} 条）`);
		await endpoints.removeNotesFromKnowledgeBase(topic.topicId, [created.noteId]);
		passed.push({ step: 'kb.noteRemove', detail: `已从「${topic.name}」移出` });
	}

	const direct = await endpoints.saveNote({ noteType: 'plain_text', title: '推送验证草稿（直存）', content: '同上' });
	check(direct.noteId.length > 0, 'save.plainText', `同步返回 ${direct.noteId}`);

	const imageNote = await exerciseImageUpload({ endpoints });

	if (process.env.GETNOTE_SMOKE_WRITE_DELETE === '1') {
		const noteIds = [created.noteId, direct.noteId, linkPush.noteId, imagePush.noteId, revived.noteId];
		if (imageNote !== null && imageNote.noteId.length > 0) noteIds.push(imageNote.noteId);
		for (const noteId of noteIds.filter((id) => id.length > 0)) await endpoints.deleteNote(noteId);
		check(true, 'delete', `测试笔记已移入回收站（${noteIds.length} 条）`);
	}
}

/** MIME types the OSS upload policy enforces, keyed by file extension. */
const MIME_BY_EXTENSION = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	bmp: 'image/bmp',
	svg: 'image/svg+xml',
};

/** 1x1 PNG used to exercise the upload path without shipping a binary fixture. */
const TINY_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Poll cadence while waiting for an asynchronous cloud task to yield its note id. */
const TASK_POLL_ATTEMPTS = 20;
const TASK_POLL_INTERVAL_MS = 1500;

/**
 * First blogger post / live of a library with details fetched. Libraries are often
 * empty, so this reports per-library counts and returns nulls when there is nothing.
 */
async function sampleContent(endpoints, topic) {
	const bloggers = await endpoints.listBloggers(topic.topicId);
	passed.push({ step: 'kb.bloggers', detail: `「${topic.name}」博主 ${bloggers.bloggers.length} 个（total=${bloggers.total}）` });
	const blogger = bloggers.bloggers[0] ?? null;
	let post = null;
	if (blogger !== null) {
		const posts = await endpoints.listBloggerPosts(topic.topicId, blogger.followId);
		passed.push({ step: 'kb.bloggerPosts', detail: `《${blogger.accountName}》内容 ${posts.posts.length} 条（total=${posts.total}）` });
		if (posts.posts.length > 0) {
			post = await endpoints.getBloggerPost(topic.topicId, posts.posts[0].postId);
			check(
				post.title.length > 0,
				'kb.bloggerDetail',
				`《${post.title}》原文 ${post.mediaText.length} 字 / 摘要 ${post.summary.length} 字`,
			);
		}
	}

	const lives = await endpoints.listLives(topic.topicId);
	passed.push({ step: 'kb.lives', detail: `「${topic.name}」直播 ${lives.lives.length} 个（total=${lives.total}）` });
	let live = null;
	if (lives.lives[0]) {
		live = await endpoints.getLive(topic.topicId, lives.lives[0].liveId);
		check(live.title.length > 0, 'kb.liveDetail', `《${live.title}》原文 ${live.mediaText.length} 字 / 摘要 ${live.summary.length} 字`);
	}
	return { blogger, post, live };
}

/**
 * Knowledge-base surface: scopes, subscriptions, folders, bloggers and lives.
 * The folder lifecycle writes with a unique name and deletes again, so the
 * account is left as it was found.
 */
async function exerciseKnowledgeBase({ endpoints, write }) {
	const scopeCounts = [];
	for (const scope of ['DEFAULT', 'BOOKSPACE', 'CUSTOMER', 'TEAMSPACE']) {
		const topics = await endpoints.listKnowledgeBases(scope);
		scopeCounts.push(`${scope}=${topics.length}`);
	}
	check(scopeCounts.length === 4, 'kb.scope', scopeCounts.join(' '));

	const subscribed = await endpoints.listSubscribedKnowledgeBases('DEFAULT');
	passed.push({ step: 'kb.subscribed', detail: `订阅知识库 ${subscribed.length} 个` });

	const own = await endpoints.listKnowledgeBases('DEFAULT');
	if (own.length === 0) {
		passed.push({ step: 'kb.skip', detail: '账号内没有 DEFAULT 知识库，跳过目录/博主/直播检查' });
		return { topic: null, blogger: null, post: null, live: null };
	}
	const first = own[0];
	const listing = await endpoints.listDirectory(first.topicId);
	check(
		listing.currentDirectory !== null,
		'kb.directory',
		`「${first.name}」根目录：${listing.directories.length} 个子目录 / ${listing.resources.length} 个资源`,
	);

	// Downstream checks (folder lifecycle, note add/remove, content import) run on a
	// library that actually has blog/live content, falling back to the first one.
	let topic = first;
	let sample = await sampleContent(endpoints, topic);
	if (sample.post === null && sample.live === null) {
		for (const candidate of own.slice(1, 6)) {
			const found = await sampleContent(endpoints, candidate);
			if (found.post !== null || found.live !== null) {
				topic = candidate;
				sample = found;
				break;
			}
		}
	}
	const { blogger, post, live } = sample;
	if (topic.topicId !== first.topicId) {
		passed.push({ step: 'kb.contentTopic', detail: `后续检查改用《${topic.name}》（首个知识库无博主/直播）` });
	}

	if (!write) return { topic, blogger, post, live };

	const name = `smoke-${Date.now().toString(36)}`;
	const directoryId = await endpoints.createDirectory(topic.topicId, name);
	check(directoryId.length > 0, 'kb.dirCreate', `新建目录 ${name}（id=${directoryId}）`);
	if (directoryId.length === 0) return { topic, blogger, post, live };
	const renamed = `${name}-renamed`;
	await endpoints.updateDirectory(topic.topicId, directoryId, { name: renamed });
	const afterRename = await endpoints.listDirectory(topic.topicId);
	check(
		afterRename.directories.some((entry) => entry.id === directoryId && entry.name === renamed),
		'kb.dirUpdate',
		`目录重命名为 ${renamed} 已生效`,
	);
	await endpoints.deleteDirectory(topic.topicId, directoryId);
	const afterDelete = await endpoints.listDirectory(topic.topicId);
	check(!afterDelete.directories.some((entry) => entry.id === directoryId), 'kb.dirDelete', '测试目录已删除');
	return { topic, blogger, post, live };
}

/**
 * Import track: a blogger post (or a live) is rendered into the temp vault and
 * journalled, and a second import must reuse the same file rather than write a
 * duplicate. The batch import is run twice to prove the journal skips unchanged
 * content without fetching each detail again.
 */
async function exerciseContentImport({ app, settings, content, topic, blogger, post, live, vaultRoot }) {
	if (topic === null || (post === null && live === null)) {
		passed.push({ step: 'content.skip', detail: '账号内没有可导入的博主内容或直播，跳过内容导入检查' });
		return;
	}
	const kind = post !== null ? 'blogger' : 'live';
	const postId = post !== null ? post.postId : live.liveId;
	const owner = post !== null ? (blogger?.accountName ?? '') : '直播';
	const importedPath = await content.importPost(topic.topicId, topic.name, kind, postId, owner);
	const file = app.vault.getAbstractFileByPath(importedPath);
	check(file instanceof TFile, 'content.import', `已导入 ${importedPath}`);
	if (!(file instanceof TFile)) return;
	const markdown = await app.vault.read(file);
	check(new RegExp(`^kind: ${kind}$`, 'm').test(markdown) && new RegExp(`^uid: "?${postId}"?$`, 'm').test(markdown), 'content.frontmatter', '导入文件带 kind 与字符串 uid');
	const again = await content.importPost(topic.topicId, topic.name, kind, postId, owner);
	check(again === importedPath, 'content.idempotent', `再次导入复用同一路径（${again}）`);

	const first = await content.importKnowledgeBaseContent(topic.topicId, topic.name);
	check(first.imported + first.skipped > 0, 'content.batch', `批量导入：新增 ${first.imported} · 跳过 ${first.skipped} · 失败 ${first.failed.length}`);
	const second = await content.importKnowledgeBaseContent(topic.topicId, topic.name);
	check(second.imported === 0 && second.failed.length === 0, 'content.incremental', `二次批量导入未重复写入（跳过 ${second.skipped}）`);
	const persisted = JSON.parse(await fs.readFile(path.join(vaultRoot, '.smoke-settings.json'), 'utf8'));
	check(
		String(persisted.contentIndex?.[postId] ?? '').startsWith(importedPath),
		'content.persisted',
		`内容日志已落盘（${persisted.contentIndex?.[postId]}）`,
	);
}

/**
 * OAuth device flow, read-only: the flow only works if the server really issues a
 * device code, and those routes share the resource `/open/api/v1` prefix — building
 * them from the bare host answers with an HTML page instead of JSON.
 */
async function exerciseOAuth({ endpoints }) {
	const clientId = (process.env.GETNOTE_CLIENT_ID ?? '').trim();
	if (clientId.length === 0) {
		passed.push({ step: 'oauth.skip', detail: '未设置 GETNOTE_CLIENT_ID，跳过设备码检查' });
		return;
	}
	const challenge = await endpoints.requestDeviceCode(clientId);
	check(
		challenge.userCode.length > 0 && /^https?:\/\//.test(challenge.verificationUri),
		'oauth.deviceCode',
		`设备码 ${challenge.userCode} → ${challenge.verificationUri}（expires_in=${challenge.expiresIn}s）`,
	);
	// Left unauthorized on purpose: polling has to report `pending`, and the server
	// expires the unused code by itself.
	const pending = await endpoints.pollDeviceToken(clientId, challenge.code);
	check(pending.state === 'pending', 'oauth.pollPending', `未授权轮询状态：${pending.state}`);
}

/** Image upload: token -> OSS multipart -> `img_text` note, all on the real service. */
async function exerciseImageUpload({ endpoints }) {
	const imagePath = process.env.GETNOTE_SMOKE_IMAGE;
	if (!imagePath) {
		passed.push({ step: 'image.upload', detail: 'skipped（未设置 GETNOTE_SMOKE_IMAGE）' });
		return null;
	}
	const bytes = new Uint8Array(await fs.readFile(imagePath));
	const extension = path.extname(imagePath).slice(1).toLowerCase();
	const url = await endpoints.uploadImage(bytes.buffer, path.basename(imagePath), MIME_BY_EXTENSION[extension] ?? 'image/png');
	check(/^https?:\/\//.test(url), 'image.upload', url);
	const note = await endpoints.saveNote({
		noteType: 'img_text',
		title: '上传链路验证草稿',
		content: '图片上传验证，可删除。',
		imageUrls: [url],
	});
	// An `img_text` save answers with a task, so the note id has to be resolved
	// before the cleanup step can delete it again.
	let noteId = note.noteId;
	const taskId = note.taskIds[0] ?? '';
	for (let attempt = 0; note.pending && noteId.length === 0 && taskId.length > 0 && attempt < TASK_POLL_ATTEMPTS; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, TASK_POLL_INTERVAL_MS));
		const progress = await endpoints.taskProgress(taskId);
		noteId = progress.noteId;
		if (noteId.length > 0) break;
		if (progress.status === 'failed') break;
	}
	check(noteId.length > 0, 'image.note', note.pending ? `异步任务 ${taskId} → 笔记 ${noteId || '未解析'}` : `笔记 ${noteId}`);
	return { ...note, noteId };
}

async function main() {
	const vaultRoot = requireEnv('GETNOTE_SMOKE_VAULT');
	const { app, endpoints, pull, push, content, settings } = buildHost(vaultRoot);

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

	await exerciseOAuth({ endpoints });

	const topics = await endpoints.listKnowledgeBases();
	check(topics.length > 0, 'knowledgeBases', `${topics.length} 个知识库，首个「${topics[0]?.name ?? ''}」`);
	if (topics.length > 0) {
		const listing = await endpoints.listDirectory(topics[0].topicId);
		check(listing.currentDirectory !== null, 'directory', `当前目录「${listing.currentDirectory?.name ?? ''}」，${listing.resources.length} 个资源`);
	}

	await exerciseDeepContent({ app, settings, pull, endpoints });

	const knowledgeBase = await exerciseKnowledgeBase({ endpoints, write: process.env.GETNOTE_SMOKE_WRITE === '1' });

	if (process.env.GETNOTE_SMOKE_WRITE === '1') {
		await exerciseContentImport({ app, content, vaultRoot, ...knowledgeBase });
		await exerciseWritePath({ vaultRoot, app, endpoints, push, topic: knowledgeBase.topic });
	} else {
		passed.push({ step: 'writePath', detail: 'skipped（未设置 GETNOTE_SMOKE_WRITE=1）' });
	}

	for (const entry of passed) console.log(`OK   ${entry.step.padEnd(20)} ${entry.detail}`);
	for (const failure of failed) console.error(`FAIL ${failure}`);
	console.log(`\n${passed.length} checks passed, ${failed.length} failed`);
	if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
	// An abort would otherwise hide everything that already passed, which is
	// exactly the context needed to find the failing call.
	console.error('smoke run aborted:', error);
	for (const entry of passed) console.error(`OK   ${entry.step.padEnd(20)} ${entry.detail}`);
	for (const failure of failed) console.error(`FAIL ${failure}`);
	process.exitCode = 1;
});
