/**
 * Domain types + settings contract for the GetNote (得到大脑 / Get笔记) channel.
 *
 * ID RULE (hard requirement): every identifier that reaches this code must be a
 * string. The API emits snowflake IDs as JSON numbers as well (e.g. `"id":
 * 1921355588034527368`), and JavaScript's `JSON.parse` silently rounds those to
 * the nearest double (…368 -> …500). Only the string twins are safe:
 * `note_id`, `cursor`, `topic_id`, `directory_id`, `follow_id_str`.
 * `parseJsonSafe()` in ./api/client.ts quotes oversized integers before parsing
 * so even the numeric twins survive, but new code must still prefer the string
 * fields.
 */

/** Raw note list / detail payload, narrowed to the fields we actually render. */
export interface NotePayload {
	/** Numeric twin. Unsafe in JS unless `parseJsonSafe` did the parsing. */
	id?: number | string;
	note_id?: string;
	title?: string;
	content?: string;
	note_type?: string;
	created_at?: string;
	updated_at?: string;
	/** `knowledge/notes` renames `updated_at` to `edit_time`. */
	edit_time?: string;
	tags?: Array<NoteTagPayload | string>;
	topics?: Array<TopicRefPayload | string>;
	ref_content?: string;
	source?: string;
	entry_type?: string;
	children_count?: number;
	children_ids?: string[];
	is_child_note?: boolean;
	parent_id?: number | string;
	parent_note_id?: string;
	attachments?: AttachmentPayload[];
	version?: number;
	share_id?: string;
	web_page?: {
		url?: string;
		excerpt?: string;
		content?: string;
	};
	audio?: {
		original?: string;
		play_url?: string;
		duration?: number;
	};
	quick_note?: string;
	timeline?: {
		version?: number;
		moments?: Array<{ start_ms?: number; end_ms?: number; text?: string }>;
		resources?: Array<{ type?: string; url?: string; action_time?: number }>;
	};
	meeting_todos?: {
		source?: string;
		items?: Array<{ text?: string; completed?: boolean }>;
	};
}

export interface NoteTagPayload {
	id?: string;
	name?: string;
	type?: string;
}

export interface TopicRefPayload {
	topic_id?: string;
	name?: string;
}

export interface AttachmentPayload {
	id?: string;
	name?: string;
	type?: string;
	url?: string;
	size?: number;
	duration?: number;
}

/** Normalised tag as used by the renderer. */
export interface NoteTag {
	id: string;
	name: string;
	type: string;
}

/** Normalised note: string-only IDs, tags flattened, aliases resolved. */
export interface Note {
	noteId: string;
	title: string;
	content: string;
	noteType: string;
	createdAt: string;
	updatedAt: string;
	tags: NoteTag[];
	topics: Array<{ topicId: string; name: string }>;
	refContent: string;
	source: string;
	entryType: string;
	shareId: string;
	childrenIds: string[];
	childrenCount: number;
	isChildNote: boolean;
	parentNoteId: string;
	attachments: AttachmentPayload[];
	webPage?: { url: string; excerpt: string; content: string };
	audio?: { original: string; playUrl: string; duration: number };
	quickNote: string;
	timeline?: NoteTimeline;
	meetingTodos?: NoteMeetingTodos;
}

export interface NoteTimeline {
	moments: Array<{ startMs: number; endMs: number; text: string }>;
	resources: Array<{ type: string; url: string; actionTime: number }>;
}

export interface NoteMeetingTodos {
	source: string;
	items: Array<{ text: string; completed: boolean }>;
}

export interface NoteListPage {
	notes: Note[];
	hasMore: boolean;
	cursor: string;
	total: number;
}

export interface RecallResult {
	noteId: string;
	noteType: string;
	title: string;
	content: string;
	createdAt: string;
	score: number;
	noteUrl: string;
}

export interface KBTopic {
	topicId: string;
	name: string;
	description: string;
	scope: string;
	createdAt: string;
	updatedAt: string;
	noteCount: number;
}

export interface KBDirectoryEntry {
	id: string;
	topicId: string;
	parentId: string;
	name: string;
	type: string;
}

export interface KBResourceEntry {
	id: string;
	directoryId: string;
	noteId: string;
	name: string;
	type: string;
	status: string;
}

export interface KBDirectoryListing {
	currentDirectory: KBDirectoryEntry | null;
	directories: KBDirectoryEntry[];
	resources: KBResourceEntry[];
}

/**
 * Knowledge-base buckets. An unscoped list answers with `DEFAULT` only, so the
 * special libraries (books, customer files, team spaces) need an explicit scope.
 */
export type KBScope = 'DEFAULT' | 'BOOKSPACE' | 'CUSTOMER' | 'TEAMSPACE';

export const KB_SCOPES: KBScope[] = ['DEFAULT', 'BOOKSPACE', 'CUSTOMER', 'TEAMSPACE'];

export const KB_SCOPE_LABELS: Record<KBScope, string> = {
	DEFAULT: '默认知识库',
	BOOKSPACE: '书籍库',
	CUSTOMER: '顾客档案',
	TEAMSPACE: '团队空间',
};

/** A blogger subscribed inside a knowledge base (`knowledge/bloggers`). */
export interface KBBlogger {
	followId: string;
	accountName: string;
	accountAvatar: string;
	notesCount: number;
	platform: string;
	hookState: string;
	followLink: string;
	followTime: string;
}

/** A blogger post as listed by `knowledge/blogger/contents`. */
export interface KBBloggerPost {
	postId: string;
	title: string;
	summary: string;
	postType: string;
	publishTime: string;
}

/** A live session as listed by `knowledge/lives`. */
export interface KBLive {
	liveId: string;
	name: string;
	status: string;
}

/** Detail shape shared by `blogger/content/detail` and `live/detail` (flat `data`). */
export interface KBPostDetail {
	postId: string;
	ownerName: string;
	title: string;
	subtitle: string;
	summary: string;
	/** `post_media_text` — the real original text, not the AI summary. */
	mediaText: string;
	postUrl: string;
	publishTime: string;
}

/** Subscription result shared by the blogger and live follow endpoints. */
export interface KBFollowResult {
	followId: string;
	url: string;
}

/** Credentials for one OSS upload (`resource/image/upload_token`). */
export interface ImageUploadToken {
	host: string;
	objectKey: string;
	accessId: string;
	policy: string;
	signature: string;
	callback: string;
	accessUrl: string;
	contentType: string;
}

/** OAuth 2.0 device authorization challenge (`oauth/device/code`). */
export interface DeviceCodeChallenge {
	code: string;
	userCode: string;
	verificationUri: string;
	expiresIn: number;
	interval: number;
}

/** Credentials returned once the device authorization completes. */
export interface DeviceCredentials {
	apiKey: string;
	clientId: string;
	expiresAt: number;
}

/** One poll attempt of the device flow: only `success` and the terminal errors stop it. */
export type DevicePollResult =
	| { state: 'pending' }
	| { state: 'success'; credentials: DeviceCredentials }
	| { state: 'error'; message: string };

/** Which knowledge-base content track a file was imported from. */
export type ContentKind = 'blogger' | 'live';

/** One imported blogger post or live session. */
export interface ContentEntry {
	kind: ContentKind;
	postId: string;
	topicId: string;
	topicName: string;
	ownerName: string;
	title: string;
	subtitle: string;
	summary: string;
	mediaText: string;
	postUrl: string;
	publishTime: string;
}

export interface QuotaBucket {
	limit: number;
	used: number;
	remaining: number;
	resetAt: number;
}

export interface QuotaWindow {
	daily: QuotaBucket;
	monthly: QuotaBucket;
}

export interface QuotaSnapshot {
	read: QuotaWindow;
	write: QuotaWindow;
	writeNote: QuotaWindow;
	aiChat: QuotaWindow;
}

export interface SaveNoteResult {
	noteId: string;
	taskIds: string[];
	/** plain_text returns synchronously; link/img_text return pending tasks. */
	pending: boolean;
}

export type TaskStatus = 'pending' | 'processing' | 'success' | 'failed';

export interface TaskProgress {
	taskId: string;
	status: TaskStatus;
	noteId: string;
}

/** Which deep-content blocks to render below the writable body. */
export interface DeepContentOptions {
	/** `web_page.content` — full original text of a link note. */
	linkOriginal: boolean;
	/** `audio.original` — recording transcript. */
	transcript: boolean;
	/** `timeline.moments` — speaker/time indexed transcript. */
	timeline: boolean;
	/** `meeting_todos.items` — meeting action items. */
	meetingTodos: boolean;
	/** `attachments[]` — attachment index with local links when downloaded. */
	attachments: boolean;
	/** `quick_note` — recording quick notes. */
	quickNote: boolean;
	/** `content` — the AI generated summary, rendered even when deep blocks exist. */
	summary: boolean;
}

export interface AttachmentTypeOptions {
	image: boolean;
	audio: boolean;
	video: boolean;
	document: boolean;
}

export interface RecallerOptions {
	/** Embedding/LLM recall results count, 1..10 (API caps `top_k` at 10). */
	topK: number;
	/** Limit recall to a single knowledge base (`topicId`), empty = global. */
	topicId: string;
	/** Open the recall sidebar once the workspace is ready, so the panel is not hidden behind a command. */
	autoOpen: boolean;
}

/** Blogger / live import track: knowledge-base content that is not a note. */
export interface ContentOptions {
	/** Import blogger posts and live sessions into the vault. */
	enabled: boolean;
	bloggers: boolean;
	lives: boolean;
	/** Vault folder for imported content; empty = below `targetFolder`. */
	folder: string;
}

export interface GetNoteChannelSettings {
	/** API key, `gk_live_xxx`. Stored in the vault's plugin data.json only. */
	apiKey: string;
	/** Client ID, `cli_xxx`. */
	clientId: string;
	/** API base, override for staging. Defaults to production. */
	apiBase: string;
	/** Note web base for `source:` links; empty derives it from `apiBase`. */
	webBase: string;
	/** Scope used by the knowledge-base list and the sync picker. */
	kbScope: KBScope;

	/** Notes are written below this vault folder. */
	targetFolder: string;
	/** Folder layout: 'flat' writes everything into targetFolder. */
	folderLayout: 'flat' | 'by-type' | 'by-date';

	/** Attachments live below this vault folder (relative to targetFolder when 'inherit'). */
	attachmentFolder: string;
	attachmentTypes: AttachmentTypeOptions;

	/** Rendering of derived content below the writable body. */
	deepContent: DeepContentOptions;

	/** Push-side options. */
	pushEnabled: boolean;
	pushFolder: string;
	/** Rewrite `https://biji.com/note/<id>` into `[[Local note]]` when possible. */
	linkToLocalNotes: boolean;

	/** Sync-side options. */
	syncOnStartup: boolean;
	syncIntervalMinutes: number;
	/** Vault-relative paths are journaled here so re-runs stay incremental. */
	index: Record<string, string>;
	lastSyncAt: number;
	recall: RecallerOptions;
	/** Blogger / live import track. */
	content: ContentOptions;
	/** Journal for imported content: post id -> "<vault path>|<publishTime>". */
	contentIndex: Record<string, string>;
}

export function defaultGetNoteSettings(): GetNoteChannelSettings {
	return {
		apiKey: '',
		clientId: '',
		apiBase: 'https://openapi.biji.com/open',
		webBase: '',
		kbScope: 'DEFAULT',
		targetFolder: 'get',
		folderLayout: 'by-type',
		attachmentFolder: 'get attachment',
		attachmentTypes: { image: true, audio: true, video: true, document: true },
		deepContent: {
			linkOriginal: true,
			transcript: true,
			timeline: true,
			meetingTodos: true,
			attachments: true,
			quickNote: true,
			summary: true,
		},
		pushEnabled: true,
		pushFolder: '',
		linkToLocalNotes: true,
		syncOnStartup: false,
		syncIntervalMinutes: 0,
		index: {},
		lastSyncAt: 0,
		recall: { topK: 5, topicId: '', autoOpen: true },
		content: { enabled: false, bloggers: true, lives: true, folder: '' },
		contentIndex: {},
	};
}

/** Marker contract shared with the upstream plugin, kept for migration. */
export const CONTENT_START = '<!-- getnote:content:start -->';
export const CONTENT_END = '<!-- getnote:content:end -->';

/** Set when the note's `uid` frontmatter field is present, i.e. push-back is possible. */
export const UID_FIELD = 'uid';
