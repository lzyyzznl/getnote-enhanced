import { ApiClient, GetNoteApiError, parseQuotaSnapshot } from './client';
import {
	DeviceCodeChallenge,
	DevicePollResult,
	ImageUploadToken,
	KBBlogger,
	KBBloggerPost,
	KBFollowResult,
	KBDirectoryListing,
	KBLive,
	KBPostDetail,
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
/** `knowledge/note/batch-add` rejects more than this many notes per request. */
const KB_NOTE_BATCH = 20;
/** Device flow: server-suggested poll interval fallback, in seconds. */
const DEVICE_POLL_DEFAULT_SECONDS = 5;
/** Terminal device-flow states; anything else keeps the caller polling. */
const DEVICE_TERMINAL_PATTERNS = ['rejected', 'expired_token', 'already_consumed'];
const RECALL_TOP_K_MIN = 1;
const RECALL_TOP_K_MAX = 10;
const RECALL_TOP_K_DEFAULT = 3;

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

/** Raw recall item -> normalised result; `note_url` may be absent. */
function normaliseRecallResult(raw: RawRecallItem): RecallResult {
	const noteId = String(raw.note_id ?? '');
	return {
		noteId,
		noteType: raw.note_type ?? '',
		title: raw.title ?? '',
		content: raw.content ?? '',
		createdAt: raw.created_at ?? '',
		score: raw.score ?? 0,
		noteUrl: raw.note_url ?? '',
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

interface RawMutationData {
	id?: string | number;
	topic_id?: string | number;
}

interface RawBlogger {
	follow_id?: string | number;
	follow_id_str?: string;
	account_name?: string;
	account_avatar?: string;
	notes_count?: number;
	platform?: string;
	hook_state?: string;
	follow_link?: string;
	follow_time?: string;
}

interface RawBloggerListData {
	bloggers?: RawBlogger[];
	has_more?: boolean;
	total?: number;
}

interface RawBloggerPost {
	post_id_alias?: string;
	post_name?: string;
	post_title?: string;
	post_summary?: string;
	post_type?: string;
	post_publish_time?: string;
}

interface RawBloggerPostListData {
	contents?: RawBloggerPost[];
	has_more?: boolean;
	total?: number;
}

interface RawLive {
	live_id?: string;
	name?: string;
	status?: string;
}

interface RawLiveListData {
	lives?: RawLive[];
	has_more?: boolean;
	total?: number;
}

/** `blogger/content/detail` and `live/detail` both answer with a flat `data`. */
interface RawPostDetail {
	post_id_alias?: string;
	post_name?: string;
	post_title?: string;
	post_subtitle?: string;
	post_summary?: string;
	post_media_text?: string;
	post_url?: string;
	post_publish_time?: string;
}

interface RawFollowData {
	follow_id?: string | number;
	follow_id_str?: string;
	url?: string;
}

interface RawUploadToken {
	host?: string;
	object_key?: string;
	accessid?: string;
	policy?: string;
	signature?: string;
	callback?: string;
	access_url?: string;
	oss_content_type?: string;
}

interface RawDeviceCodeData {
	code?: string;
	user_code?: string;
	verification_uri?: string;
	expires_in?: number;
	interval?: number;
}

interface RawDeviceTokenData {
	api_key?: string;
	client_id?: string;
	expires_at?: number;
}

/**
 * Both track kinds answer with the same flat shape; `post_id_alias` is the live id.
 *
 * The detail payload is not a superset of the listing: a video post comes back with
 * `post_id_alias` and `post_title` set to empty strings, keeping the readable name in
 * `post_name`. Empty strings are therefore treated as absent (a `??` fallback would
 * keep them and the next fetch would fail with 参数错误), and the id to reuse stays
 * the one the caller already had.
 */
function normalisePostDetail(raw: RawPostDetail, fallbackId: string): KBPostDetail {
	const alias = (raw.post_id_alias ?? '').trim();
	const title = (raw.post_title ?? '').trim();
	const name = (raw.post_name ?? '').replace(/\s+/g, ' ').trim();
	return {
		postId: alias.length > 0 ? alias : fallbackId,
		ownerName: name,
		title: title.length > 0 ? title : name,
		subtitle: raw.post_subtitle ?? '',
		summary: raw.post_summary ?? '',
		mediaText: raw.post_media_text ?? '',
		postUrl: raw.post_url ?? '',
		publishTime: raw.post_publish_time ?? '',
	};
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
		return this.decorateRecall((data.results ?? []).map(normaliseRecallResult));
	}

	async recallKnowledgeBase(topicId: string, query: string, topK: number): Promise<RecallResult[]> {
		const data = await this.client.request<RawRecallData>('/resource/recall/knowledge', {
			method: 'POST',
			body: { topic_id: topicId, query, top_k: clampTopK(topK) },
		});
		return this.decorateRecall((data.results ?? []).map(normaliseRecallResult));
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
		/** Retry-safe key: reuse the same value when retrying one creation. */
		clientRequestId?: string;
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
				client_request_id: request.clientRequestId,
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

	/** `knowledge/create` answers with an opaque payload, so callers re-list. */
	async createKnowledgeBase(name: string, description = ''): Promise<void> {
		await this.client.request<unknown>('/resource/knowledge/create', {
			method: 'POST',
			body: { name, description: description.length > 0 ? description : undefined },
		});
	}

	/** `note/batch-add` caps one request at 20 notes, so the list is chunked here. */
	async addNotesToKnowledgeBase(topicId: string, noteIds: string[], directoryId = ''): Promise<number> {
		let added = 0;
		for (let index = 0; index < noteIds.length; index += KB_NOTE_BATCH) {
			const chunk = noteIds.slice(index, index + KB_NOTE_BATCH);
			await this.client.request<unknown>('/resource/knowledge/note/batch-add', {
				method: 'POST',
				body: {
					topic_id: topicId,
					directory_id: directoryId.length > 0 ? directoryId : undefined,
					note_ids: chunk,
				},
			});
			added += chunk.length;
		}
		return added;
	}

	async removeNotesFromKnowledgeBase(topicId: string, noteIds: string[]): Promise<void> {
		await this.client.request<unknown>('/resource/knowledge/note/remove', {
			method: 'POST',
			body: { topic_id: topicId, note_ids: noteIds },
		});
	}

	async createDirectory(topicId: string, name: string, parentId = ''): Promise<string> {
		const data = await this.client.request<RawMutationData>('/resource/knowledge/directory/create', {
			method: 'POST',
			body: { topic_id: topicId, parent_id: parentId.length > 0 ? parentId : undefined, name },
		});
		return String(data?.id ?? '');
	}

	/** `update` doubles as rename and move: send only the field that changes. */
	async updateDirectory(
		topicId: string,
		directoryId: string,
		changes: { name?: string; parentId?: string },
	): Promise<void> {
		await this.client.request<unknown>('/resource/knowledge/directory/update', {
			method: 'POST',
			body: {
				topic_id: topicId,
				directory_id: directoryId,
				name: changes.name,
				parent_id: changes.parentId,
			},
		});
	}

	async deleteDirectory(topicId: string, directoryId: string): Promise<void> {
		await this.client.request<unknown>('/resource/knowledge/directory/delete', {
			method: 'POST',
			body: { topic_id: topicId, directory_id: directoryId },
		});
	}

	/** `note/tags/add` only appends; removal needs the tag id, not its name. */
	async deleteTag(noteId: string, tagId: string): Promise<void> {
		await this.client.request<unknown>('/resource/note/tags/delete', {
			method: 'POST',
			body: { note_id: noteId, tag_id: tagId },
		});
	}

	/** Recall hits may omit `note_url`; the environment-correct link is filled in here. */
	private decorateRecall(results: RecallResult[]): RecallResult[] {
		const base = `${this.client.getWebBase()}/note/`;
		return results.map((result) =>
			result.noteUrl.length > 0 || result.noteId.length === 0 ? result : { ...result, noteUrl: `${base}${result.noteId}` },
		);
	}

	async listBloggers(topicId: string, page = 1): Promise<{ bloggers: KBBlogger[]; hasMore: boolean; total: number }> {
		const data = await this.client.request<RawBloggerListData>('/resource/knowledge/bloggers', {
			query: { topic_id: topicId, page },
		});
		return {
			bloggers: (data.bloggers ?? []).map((raw) => ({
				followId: String(raw.follow_id_str || raw.follow_id || ''),
				accountName: raw.account_name ?? '',
				accountAvatar: raw.account_avatar ?? '',
				notesCount: raw.notes_count ?? 0,
				platform: raw.platform ?? '',
				hookState: raw.hook_state ?? '',
				followLink: raw.follow_link ?? '',
				followTime: raw.follow_time ?? '',
			})),
			hasMore: data.has_more === true,
			total: data.total ?? 0,
		};
	}

	async followBlogger(topicId: string, link: string, platform = ''): Promise<KBFollowResult> {
		const data = await this.client.request<RawFollowData>('/resource/knowledge/blogger/follow', {
			method: 'POST',
			body: { topic_id: topicId, link, platform: platform.length > 0 ? platform : undefined },
		});
		return { followId: String(data.follow_id_str || data.follow_id || ''), url: data.url ?? '' };
	}

	async listBloggerPosts(
		topicId: string,
		followId: string,
		page = 1,
	): Promise<{ posts: KBBloggerPost[]; hasMore: boolean; total: number }> {
		const data = await this.client.request<RawBloggerPostListData>('/resource/knowledge/blogger/contents', {
			query: { topic_id: topicId, follow_id: followId, page },
		});
		return {
			posts: (data.contents ?? []).map((raw) => ({
				postId: (raw.post_id_alias ?? '').trim(),
				// Same empty-`post_title` story as the detail payload: `post_name` is
				// the fallback the listing itself uses for video posts.
				title: (raw.post_title ?? '').trim() || (raw.post_name ?? '').replace(/\s+/g, ' ').trim(),
				summary: raw.post_summary ?? '',
				postType: raw.post_type ?? '',
				publishTime: raw.post_publish_time ?? '',
			})),
			hasMore: data.has_more === true,
			total: data.total ?? 0,
		};
	}

	async getBloggerPost(topicId: string, postId: string): Promise<KBPostDetail> {
		const data = await this.client.request<RawPostDetail>('/resource/knowledge/blogger/content/detail', {
			query: { topic_id: topicId, post_id: postId },
		});
		return normalisePostDetail(data, postId);
	}

	async listLives(topicId: string, page = 1): Promise<{ lives: KBLive[]; hasMore: boolean; total: number }> {
		const data = await this.client.request<RawLiveListData>('/resource/knowledge/lives', {
			query: { topic_id: topicId, page },
		});
		return {
			lives: (data.lives ?? []).map((raw) => ({
				liveId: raw.live_id ?? '',
				name: raw.name ?? '',
				status: raw.status ?? '',
			})),
			hasMore: data.has_more === true,
			total: data.total ?? 0,
		};
	}

	async getLive(topicId: string, liveId: string): Promise<KBPostDetail> {
		const data = await this.client.request<RawPostDetail>('/resource/knowledge/live/detail', {
			query: { topic_id: topicId, live_id: liveId },
		});
		return normalisePostDetail(data, liveId);
	}

	async followLive(topicId: string, link: string, platform = ''): Promise<KBFollowResult> {
		const data = await this.client.request<RawFollowData>('/resource/knowledge/live/follow', {
			method: 'POST',
			body: { topic_id: topicId, link, platform: platform.length > 0 ? platform : undefined },
		});
		return { followId: String(data.follow_id_str || data.follow_id || ''), url: data.url ?? '' };
	}

	/** Step 1 of the device flow; the `clientId` is the user's own OAuth app. */
	async requestDeviceCode(clientId: string): Promise<DeviceCodeChallenge> {
		const payload = await this.client.requestOAuth('/oauth/device/code', { client_id: clientId });
		const data = (payload.data ?? {}) as RawDeviceCodeData;
		const code = data.code ?? '';
		if (payload.success !== true || code.length === 0) {
			throw new GetNoteApiError({ message: '授权请求失败：接口未返回设备码，请检查 Client ID。' });
		}
		return {
			code,
			userCode: data.user_code ?? '',
			verificationUri: data.verification_uri ?? '',
			expiresIn: data.expires_in ?? 0,
			interval: data.interval !== undefined && data.interval > 0 ? data.interval : DEVICE_POLL_DEFAULT_SECONDS,
		};
	}

	/**
	 * Step 2: one poll attempt, no sleeping here — the caller owns the interval and
	 * deadline. Anything that is not a terminal state stays `pending`, mirroring the
	 * reference CLI, so a transient server error cannot abort an authorization.
	 */
	async pollDeviceToken(clientId: string, code: string): Promise<DevicePollResult> {
		const payload = await this.client.requestOAuth('/oauth/token', {
			grant_type: 'device_code',
			client_id: clientId,
			code,
		});
		const data = (payload.data ?? {}) as RawDeviceTokenData;
		const apiKey = data.api_key ?? '';
		if (payload.success === true && apiKey.length > 0) {
			return {
				state: 'success',
				credentials: { apiKey, clientId: data.client_id || clientId, expiresAt: data.expires_at ?? 0 },
			};
		}
		const raw = JSON.stringify(payload);
		if (raw.includes('authorization_pending')) return { state: 'pending' };
		const terminal = DEVICE_TERMINAL_PATTERNS.find((pattern) => raw.includes(pattern));
		if (terminal !== undefined) {
			const reason = String(((payload.error ?? {}) as Record<string, unknown>).message ?? terminal);
			return { state: 'error', message: reason };
		}
		return { state: 'pending' };
	}

	async getImageUploadToken(mimeType: string): Promise<ImageUploadToken> {
		const data = await this.client.request<RawUploadToken>('/resource/image/upload_token', {
			query: { mime_type: mimeType, count: 1 },
		});
		const token: ImageUploadToken = {
			host: data?.host ?? '',
			objectKey: data?.object_key ?? '',
			accessId: data?.accessid ?? '',
			policy: data?.policy ?? '',
			signature: data?.signature ?? '',
			callback: data?.callback ?? '',
			accessUrl: data?.access_url ?? '',
			contentType: data?.oss_content_type ?? mimeType,
		};
		if (token.host.length === 0 || token.objectKey.length === 0) {
			throw new GetNoteApiError({ message: '上传失败：接口未返回上传凭证。' });
		}
		return token;
	}

	/** Uploads one image and returns its public URL, ready for `note/save`'s `image_urls`. */
	async uploadImage(bytes: ArrayBuffer, fileName: string, mimeType: string): Promise<string> {
		const token = await this.getImageUploadToken(mimeType);
		// Field order and the file part's Content-Type are OSS policy requirements.
		await this.client.postMultipart(
			token.host,
			[
				['key', token.objectKey],
				['OSSAccessKeyId', token.accessId],
				['policy', token.policy],
				['signature', token.signature],
				['callback', token.callback],
				['Content-Type', token.contentType],
			],
			{ field: 'file', filename: fileName, contentType: token.contentType, bytes },
		);
		return token.accessUrl;
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
