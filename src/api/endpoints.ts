import { ApiClient, GetNoteApiError, parseQuotaSnapshot } from './client';
import {
	KBDirectoryListing,
	KBTopic,
	Note,
	NoteListPage,
	NotePayload,
	QuotaSnapshot,
	RecallResult,
	SaveNoteResult,
	TaskProgress,
	TaskStatus,
} from '../types';

/**
 * Typed wrappers for the 得到大脑 (Get笔记) OpenAPI resources.
 *
 * Verified quirks this module has to absorb:
 *  - `note/list` always returns 20 notes (`limit` is ignored) and pages with the
 *    STRING `cursor`; `next_cursor` is a legacy numeric twin and is never read.
 *  - `note/save` answers synchronously for `plain_text` (`note_id`) but with
 *    `{created_count, tasks:[{task_id,url}]}` for `link` / `img_text`, which the
 *    caller has to poll through `note/task/progress`.
 *  - `knowledge/notes` emits `edit_time` where every other note endpoint emits
 *    `updated_at`, and returns tags as bare strings.
 *  - every identifier travels as a string; `id` / `parent_id` numeric twins are
 *    stringified but never parsed with `Number` (snowflakes exceed 2^53).
 */

/** `note/list` ignores `limit` and always answers with this many notes. */
const NOTE_PAGE_SIZE = 20;
/** Safety valve for the `page`/`has_more` loops. */
const MAX_PAGES = 20;
const RECALL_TOP_K_MIN = 1;
const RECALL_TOP_K_MAX = 10;
const RECALL_TOP_K_DEFAULT = 3;
const NOTE_WEB_BASE = 'https://www.biji.com/note/';

interface RawNoteDetailData {
	note?: NotePayload;
}

interface RawNoteListData {
	notes?: NotePayload[];
	has_more?: boolean;
	total?: number;
	/** Recommended pagination field; a sibling `next_cursor` also exists. */
	cursor?: string;
}

interface RawRecallItem {
	note_id?: string;
	note_url?: string;
	note_type?: string;
	title?: string;
	content?: string;
	created_at?: string;
	score?: number;
}

interface RawRecallData {
	results?: RawRecallItem[];
}

interface RawTopicStats {
	note_count?: number;
}

interface RawTopic {
	id?: string;
	topic_id?: string;
	name?: string;
	description?: string;
	scope?: string;
	created_at?: string;
	updated_at?: string;
	stats?: RawTopicStats;
}

interface RawTopicListData {
	topics?: RawTopic[];
	has_more?: boolean;
	total?: number;
}

interface RawKBNoteListData {
	notes?: NotePayload[];
	has_more?: boolean;
	total?: number;
}

interface RawDirectory {
	id?: string;
	topic_id?: string;
	parent_id?: string;
	name?: string;
	type?: string;
}

interface RawResource {
	id?: string;
	directory_id?: string;
	note_id?: string;
	name?: string;
	type?: string;
	status?: string;
}

interface RawDirectoryListData {
	current_directory?: RawDirectory;
	directories?: RawDirectory[];
	resources?: RawResource[];
}

interface RawSaveTask {
	task_id?: string;
	url?: string;
}

interface RawSaveData {
	note_id?: string;
	created_count?: number;
	tasks?: RawSaveTask[];
}

interface RawShareData {
	share_url?: string;
}

interface RawTaskProgressData {
	task_id?: string;
	status?: string;
	note_id?: string;
}

/** `top_k` outside 1..10 is rejected by the API; a non-numeric value falls back. */
function clampTopK(topK: number): number {
	if (!Number.isFinite(topK)) return RECALL_TOP_K_DEFAULT;
	return Math.min(RECALL_TOP_K_MAX, Math.max(RECALL_TOP_K_MIN, Math.trunc(topK)));
}

/** `done` is the historical alias of `success`; unknown states keep the caller polling. */
function normaliseTaskStatus(status: string | undefined): TaskStatus {
	if (status === 'pending' || status === 'processing' || status === 'success' || status === 'failed') return status;
	return status === 'done' ? 'success' : 'pending';
}

function normaliseRecallResult(raw: RawRecallItem): RecallResult {
	const noteId = String(raw.note_id ?? '');
	return {
		noteId,
		noteType: raw.note_type ?? '',
		title: raw.title ?? '',
		content: raw.content ?? '',
		createdAt: raw.created_at ?? '',
		score: raw.score ?? 0,
		noteUrl: raw.note_url || (noteId.length > 0 ? `${NOTE_WEB_BASE}${noteId}` : ''),
	};
}

/** Raw note payload -> string-only IDs, flattened tags, resolved aliases. */
export function normaliseNote(payload: NotePayload): Note {
	const childrenIds = (payload.children_ids ?? []).map((id) => String(id));
	const note: Note = {
		noteId: String(payload.note_id || payload.id || ''),
		title: payload.title ?? '',
		content: payload.content ?? '',
		noteType: payload.note_type ?? '',
		createdAt: payload.created_at ?? '',
		updatedAt: payload.updated_at || payload.edit_time || payload.created_at || '',
		tags: (payload.tags ?? []).map((tag) =>
			typeof tag === 'string'
				? { id: `name:${tag}`, name: tag, type: 'unknown' }
				: { id: tag.id || `name:${tag.name ?? ''}`, name: tag.name ?? '', type: tag.type ?? 'unknown' },
		),
		topics: (payload.topics ?? []).map((topic) =>
			typeof topic === 'string'
				? { topicId: '', name: topic }
				: { topicId: String(topic.topic_id ?? ''), name: topic.name ?? '' },
		),
		refContent: payload.ref_content ?? '',
		source: payload.source ?? '',
		entryType: payload.entry_type ?? '',
		shareId: payload.share_id ?? '',
		childrenIds,
		childrenCount: payload.children_count ?? childrenIds.length,
		isChildNote: payload.is_child_note === true,
		parentNoteId: String(payload.parent_note_id || payload.parent_id || ''),
		attachments: (payload.attachments ?? []).map((attachment) => ({
			...attachment,
			id: String(attachment.id ?? ''),
			name: attachment.name ?? '',
			type: attachment.type ?? '',
			url: attachment.url ?? '',
		})),
		quickNote: payload.quick_note ?? '',
	};

	const webPage = payload.web_page;
	if (webPage && (webPage.url || webPage.excerpt || webPage.content)) {
		note.webPage = {
			url: webPage.url ?? '',
			excerpt: webPage.excerpt ?? '',
			content: webPage.content ?? '',
		};
	}

	const audio = payload.audio;
	if (audio && (audio.original || audio.play_url || audio.duration)) {
		note.audio = {
			original: audio.original ?? '',
			playUrl: audio.play_url ?? '',
			duration: audio.duration ?? 0,
		};
	}

	const moments = payload.timeline?.moments ?? [];
	const resources = payload.timeline?.resources ?? [];
	if (moments.length > 0 || resources.length > 0) {
		note.timeline = {
			moments: moments.map((moment) => ({
				startMs: moment.start_ms ?? 0,
				endMs: moment.end_ms ?? 0,
				text: moment.text ?? '',
			})),
			resources: resources.map((resource) => ({
				type: resource.type ?? '',
				url: resource.url ?? '',
				actionTime: resource.action_time ?? 0,
			})),
		};
	}

	const todos = payload.meeting_todos?.items ?? [];
	if (todos.length > 0) {
		note.meetingTodos = {
			source: payload.meeting_todos?.source ?? '',
			items: todos.map((item) => ({ text: item.text ?? '', completed: item.completed === true })),
		};
	}

	return note;
}

export class GetNoteEndpoints {
	private readonly client: ApiClient;

	constructor(client: ApiClient) {
		this.client = client;
	}

	async listNotes(params: { cursor?: string } = {}): Promise<NoteListPage> {
		const data = await this.client.request<RawNoteListData>('/resource/note/list', {
			query: { cursor: params.cursor },
		});
		const notes = (data.notes ?? []).map((raw) => normaliseNote(raw));
		const cursor = data.cursor ?? '';
		return {
			notes,
			// The server ignores `limit`, so a full page plus a next cursor is the
			// only signal left when `has_more` is missing.
			hasMore:
				data.has_more === true ||
				(data.has_more === undefined && cursor.length > 0 && notes.length >= NOTE_PAGE_SIZE),
			cursor,
			total: data.total ?? notes.length,
		};
	}

	async getNote(noteId: string, options: { originalImages?: boolean } = {}): Promise<Note> {
		const data = await this.client.request<RawNoteDetailData>('/resource/note/detail', {
			query: { id: noteId, image_quality: options.originalImages === true ? 'original' : undefined },
		});
		return normaliseNote(data.note ?? {});
	}

	async recall(query: string, topK: number): Promise<RecallResult[]> {
		const data = await this.client.request<RawRecallData>('/resource/recall', {
			method: 'POST',
			body: { query, top_k: clampTopK(topK) },
		});
		return (data.results ?? []).map(normaliseRecallResult);
	}

	async recallKnowledgeBase(topicId: string, query: string, topK: number): Promise<RecallResult[]> {
		const data = await this.client.request<RawRecallData>('/resource/recall/knowledge', {
			method: 'POST',
			body: { topic_id: topicId, query, top_k: clampTopK(topK) },
		});
		return (data.results ?? []).map(normaliseRecallResult);
	}

	async listKnowledgeBases(scope = ''): Promise<KBTopic[]> {
		return this.collectKnowledgeBases('/resource/knowledge/list', scope);
	}

	async listSubscribedKnowledgeBases(scope = ''): Promise<KBTopic[]> {
		return this.collectKnowledgeBases('/resource/knowledge/subscribe/list', scope);
	}

	async listKnowledgeBaseNotes(params: { topicId: string; page: number }): Promise<{ notes: Note[]; total: number }> {
		const notes: Note[] = [];
		let total = 0;
		const firstPage = Math.max(1, params.page);
		for (let page = firstPage; page < firstPage + MAX_PAGES; page++) {
			const data = await this.client.request<RawKBNoteListData>('/resource/knowledge/notes', {
				query: { topic_id: params.topicId, page },
			});
			for (const raw of data.notes ?? []) notes.push(normaliseNote(raw));
			total = data.total ?? notes.length;
			if (data.has_more !== true) break;
		}
		return { notes, total };
	}

	async listDirectory(topicId: string, directoryId = ''): Promise<KBDirectoryListing> {
		const data = await this.client.request<RawDirectoryListData>('/resource/knowledge/directories', {
			query: { topic_id: topicId, directory_id: directoryId },
		});
		// The current directory arrives in its own field but shares the shape of
		// `directories[]`, so one pass normalises both.
		const current = data.current_directory;
		const entries = (current ? [current, ...(data.directories ?? [])] : (data.directories ?? [])).map((raw) => ({
			id: String(raw.id ?? ''),
			topicId: String(raw.topic_id ?? ''),
			parentId: String(raw.parent_id ?? ''),
			name: raw.name ?? '',
			type: raw.type ?? '',
		}));
		return {
			currentDirectory: current ? entries[0] : null,
			directories: current ? entries.slice(1) : entries,
			resources: (data.resources ?? []).map((raw) => ({
				id: String(raw.id ?? ''),
				directoryId: String(raw.directory_id ?? ''),
				noteId: String(raw.note_id ?? ''),
				name: raw.name ?? '',
				type: raw.type ?? '',
				status: raw.status ?? '',
			})),
		};
	}

	async getQuota(): Promise<QuotaSnapshot | null> {
		const data = await this.client.request<unknown>('/resource/rate-limit/quota');
		const quota = parseQuotaSnapshot(data);
		// A successful quota read proves the budget is usable again, so the
		// circuit breaker in the client is cleared here.
		this.client.reportQuota(quota);
		return quota;
	}

	async saveNote(request: {
		noteType: 'plain_text' | 'link' | 'img_text';
		title?: string;
		content?: string;
		linkUrl?: string;
		imageUrls?: string[];
		tags?: string[];
		topicId?: string;
		parentId?: string;
	}): Promise<SaveNoteResult> {
		const data = await this.client.request<RawSaveData>('/resource/note/save', {
			method: 'POST',
			body: {
				note_type: request.noteType,
				title: request.title,
				content: request.content,
				link_url: request.linkUrl,
				image_urls: request.imageUrls,
				tags: request.tags,
				topic_id: request.topicId,
				parent_id: request.parentId,
			},
		});
		const tasks = data.tasks ?? [];
		if (tasks.length > 0) {
			return { noteId: '', taskIds: tasks.map((task) => String(task.task_id ?? '')), pending: true };
		}
		return { noteId: String(data.note_id ?? ''), taskIds: [], pending: false };
	}

	async updateNote(request: { noteId: string; title?: string; content?: string; tags?: string[] }): Promise<void> {
		// `id` is sent alongside `note_id`: the reference CLI (getnote-cli) patches
		// notes with `id`, and this endpoint tolerates the extra alias.
		const body: Record<string, unknown> = { note_id: request.noteId, id: request.noteId };
		if (request.title !== undefined) body.title = request.title;
		if (request.content !== undefined) body.content = request.content;
		if (request.tags !== undefined) body.tags = request.tags;
		await this.client.request<unknown>('/resource/note/update', { method: 'POST', body });
	}

	async deleteNote(noteId: string): Promise<void> {
		await this.client.request<unknown>('/resource/note/delete', {
			method: 'POST',
			body: { note_id: noteId },
		});
	}

	async addTags(noteId: string, tags: string[]): Promise<void> {
		await this.client.request<unknown>('/resource/note/tags/add', {
			method: 'POST',
			body: { note_id: noteId, tags },
		});
	}

	async shareNote(noteId: string, excludeAudio: boolean): Promise<string> {
		const data = await this.client.request<RawShareData>('/resource/note/sharing', {
			method: 'POST',
			body: { note_id: noteId, share_exclude_audio: excludeAudio },
		});
		const shareUrl = data.share_url ?? '';
		if (shareUrl.length === 0) {
			throw new GetNoteApiError({ message: '分享失败：接口未返回 share_url。' });
		}
		return shareUrl;
	}

	async taskProgress(taskId: string): Promise<TaskProgress> {
		const data = await this.client.request<RawTaskProgressData>('/resource/note/task/progress', {
			method: 'POST',
			body: { task_id: taskId },
		});
		return {
			taskId: data.task_id || taskId,
			status: normaliseTaskStatus(data.status),
			noteId: String(data.note_id ?? ''),
		};
	}

	private async collectKnowledgeBases(path: string, scope: string): Promise<KBTopic[]> {
		const topics: KBTopic[] = [];
		for (let page = 1; page <= MAX_PAGES; page++) {
			const data = await this.client.request<RawTopicListData>(path, { query: { page, scope } });
			for (const raw of data.topics ?? []) {
				topics.push({
					topicId: String(raw.topic_id || raw.id || ''),
					name: raw.name ?? '',
					description: raw.description ?? '',
					scope: raw.scope ?? '',
					createdAt: raw.created_at ?? '',
					updatedAt: raw.updated_at ?? '',
					noteCount: raw.stats?.note_count ?? 0,
				});
			}
			if (data.has_more !== true) break;
		}
		return topics;
	}
}
