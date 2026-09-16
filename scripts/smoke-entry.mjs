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

import { TFile, createVaultBackedApp } from 'obsidian';

import { ApiClient } from '../src/api/client';
import { GetNoteEndpoints } from '../src/api/endpoints';
import { PullEngine } from '../src/sync/pull';
import { PushEngine } from '../src/sync/push';
import { extractWritableBody, renderNoteMarkdown } from '../src/sync/render';
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
	const { app, endpoints, pull, push } = buildHost(vaultRoot);

	const quota = await endpoints.getQuota();
	check(quota !== null, 'quota', quota ? `读取剩余 ${quota.read.daily.remaining}/${quota.read.daily.limit}，写入剩余 ${quota.write.daily.remaining}/${quota.write.daily.limit}` : '未返回配额数据');

	const page = await endpoints.listNotes({});
	check(page.notes.length > 0, 'list', `第一页 ${page.notes.length} 条，hasMore=${page.hasMore}，total=${page.total}`);
	const sample = page.notes[0];
	check(/^\d{16,}$/.test(sample.noteId), 'list.id', `note_id 为字符串且未丢精度：${sample.noteId}`);

	const detail = await endpoints.getNote(sample.noteId);
	check(detail.noteId === sample.noteId, 'detail', `详情与列表一致（${detail.noteType}）`);

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

	const deepNote = page.notes.find((note) => note.noteType !== 'plain_text');
	if (deepNote) {
		const deepReport = await pull.syncNote(deepNote.noteId);
		check(deepReport.failed.length === 0, 'pull.deepNote', `${deepNote.noteType} 笔记（${deepReport.created + deepReport.updated} 个文件，${deepReport.attachments} 个附件）`);
	}

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
