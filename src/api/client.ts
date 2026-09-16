import { requestUrl } from 'obsidian';

import { QuotaBucket, QuotaSnapshot, QuotaWindow } from '../types';

/**
 * Transport for the 得到大脑 (Get笔记) OpenAPI.
 *
 * Verified against production (2026-09-16):
 *  - headers: `Authorization: gk_live_xxx` (no Bearer prefix) + `X-Client-ID: cli_xxx`;
 *    a missing client ID returns HTTP 401 `{code:10004, reason:"unauthorized"}`.
 *  - envelope: `{success, data, error, meta, request_id}`; business failures may
 *    arrive with HTTP 200 and `success:false`, so `success` decides.
 *  - snowflake IDs are emitted both as JSON numbers (unsafe) and as strings;
 *    see `parseJsonSafe`.
 */

export interface GetNoteCredentials {
	apiKey: string;
	clientId: string;
	apiBase: string;
}

export class GetNoteApiError extends Error {
	readonly code: number;
	readonly reason: string;
	readonly retryable: boolean;
	readonly httpStatus: number;
	readonly requestId: string;
	readonly rateLimit: QuotaSnapshot | null;

	constructor(init: {
		message: string;
		code?: number;
		reason?: string;
		retryable?: boolean;
		httpStatus?: number;
		requestId?: string;
		rateLimit?: QuotaSnapshot | null;
	}) {
		super(init.message);
		this.name = 'GetNoteApiError';
		this.code = init.code ?? 0;
		this.reason = init.reason ?? '';
		this.retryable = init.retryable ?? false;
		this.httpStatus = init.httpStatus ?? 0;
		this.requestId = init.requestId ?? '';
		this.rateLimit = init.rateLimit ?? null;
	}

	/** Quota exhaustion / non-member states must not be retried and must gate the UI. */
	get isQuotaExhausted(): boolean {
		return this.reason === 'quota_day' || this.reason === 'quota_month';
	}

	get isNotMember(): boolean {
		return this.reason === 'not_member' || this.code === 10201;
	}
}

const OVERSIZED_INTEGER_MIN_DIGITS = 16;

/**
 * `Promise.withResolvers` is the resolver-first way to await a timer. Older
 * WebViews (iOS < 17.4) lack it; the retry path then retries without backoff
 * instead of crashing.
 */
interface DeferredCapablePromise {
	withResolvers?<T>(): {
		promise: Promise<T>;
		resolve: (value: T | PromiseLike<T>) => void;
		reject: (reason?: unknown) => void;
	};
}

/** Await `ms` when the runtime can, otherwise return immediately. */
export async function pause(ms: number): Promise<void> {
	// `Promise.withResolvers` is brand-checked on `this`, so it must be called as
	// a method — a detached reference throws `TypeError: called on non-object`.
	const deferred = (Promise as unknown as DeferredCapablePromise).withResolvers?.<void>();
	if (!deferred) return;
	window.setTimeout(deferred.resolve, ms);
	await deferred.promise;
}

/**
 * `JSON.parse` rounds integers beyond `Number.MAX_SAFE_INTEGER`, which silently
 * corrupts snowflake IDs (verified: 1921355588034527368 -> 1921355588034527500).
 * Quote oversized integer tokens before parsing so nothing is lost; string
 * literals are copied verbatim, so note bodies stay untouched.
 */
export function parseJsonSafe(text: string): unknown {
	let out = '';
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '"') {
			const start = i;
			i++;
			while (i < text.length) {
				const c = text[i];
				if (c === '\\') {
					i += 2;
					continue;
				}
				i++;
				if (c === '"') break;
			}
			out += text.slice(start, i);
			continue;
		}
		if (ch === '-' || (ch >= '0' && ch <= '9')) {
			const start = i;
			if (ch === '-') i++;
			let digits = 0;
			while (i < text.length && text[i] >= '0' && text[i] <= '9') {
				digits++;
				i++;
			}
			const token = text.slice(start, i);
			const head = i < text.length ? text[i] : '';
			const isFloat = head === '.' || head === 'e' || head === 'E';
			out += !isFloat && digits >= OVERSIZED_INTEGER_MIN_DIGITS ? `"${token}"` : token;
			continue;
		}
		out += ch;
		i++;
	}
	return JSON.parse(out);
}

/** Accepts `{daily:{limit,used,remaining,reset_at}}` in either casing. */
export function parseQuotaWindow(raw: unknown): QuotaWindow | null {
	if (!raw || typeof raw !== 'object') return null;
	const source = raw as Record<string, unknown>;
	const daily = parseQuotaBucket(source.daily);
	const monthly = parseQuotaBucket(source.monthly);
	if (!daily || !monthly) return null;
	return { daily, monthly };
}

function parseQuotaBucket(raw: unknown): QuotaBucket | null {
	if (!raw || typeof raw !== 'object') return null;
	const source = raw as Record<string, unknown>;
	const limit = Number(source.limit);
	const used = Number(source.used);
	if (!Number.isFinite(limit) || !Number.isFinite(used)) return null;
	const remaining = Number(source.remaining);
	return {
		limit,
		used,
		remaining: Number.isFinite(remaining) ? remaining : limit - used,
		resetAt: Number(source.reset_at ?? source.resetAt ?? 0) || 0,
	};
}

/** Maps the `/resource/rate-limit/quota` payload onto the four budget buckets. */
export function parseQuotaSnapshot(raw: unknown): QuotaSnapshot | null {
	if (!raw || typeof raw !== 'object') return null;
	const source = raw as Record<string, unknown>;
	const read = parseQuotaWindow(source.read);
	const write = parseQuotaWindow(source.write);
	const writeNote = parseQuotaWindow(source.write_note);
	const aiChat = parseQuotaWindow(source.ai_chat);
	if (!read || !write || !writeNote || !aiChat) return null;
	return { read, write, writeNote, aiChat };
}

/** `https://host`, `https://host/open` and `https://host/open/api/v1` all normalise. */
export function normaliseApiBase(apiBase: string): string {
	const trimmed = apiBase.trim().replace(/\/+$/, '');
	if (trimmed.length === 0) return 'https://openapi.biji.com/open/api/v1';
	if (trimmed.endsWith('/open/api/v1')) return trimmed;
	if (trimmed.endsWith('/open')) return `${trimmed}/api/v1`;
	return `${trimmed}/open/api/v1`;
}

export interface ApiRequestOptions {
	method?: 'GET' | 'POST';
	query?: Record<string, string | number | undefined>;
	body?: unknown;
}

export class ApiClient {
	private readonly readCredentials: () => GetNoteCredentials;
	private quota: QuotaSnapshot | null = null;
	private quotaListeners: Array<(quota: QuotaSnapshot) => void> = [];
	private blockedReason = '';

	constructor(readCredentials: () => GetNoteCredentials) {
		this.readCredentials = readCredentials;
	}

	onQuota(listener: (quota: QuotaSnapshot) => void): void {
		this.quotaListeners.push(listener);
		if (this.quota) listener(this.quota);
	}

	getQuota(): QuotaSnapshot | null {
		return this.quota;
	}

	/** Reason why calls are currently refused, empty when the client is healthy. */
	getBlockedReason(): string {
		return this.blockedReason;
	}

	/** Called after a human resolved the budget/membership problem. */
	clearBlock(): void {
		this.blockedReason = '';
	}

	async request<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
		const response = await this.sendWithRetry(path, options);
		const payload = response.text.length > 0 ? (parseJsonSafe(response.text) as Record<string, unknown>) : null;
		if (payload && payload.success === true) return payload.data as T;
		throw this.toApiError(payload, response.status, response.headers);
	}

	/** Plain-text fetch used for attachments; signed CDN URLs do not need headers. */
	async fetchText(url: string, authenticated = false): Promise<string> {
		const request = await requestUrl({
			url,
			method: 'GET',
			headers: authenticated ? this.authHeaders() : {},
			throw: false,
		});
		if (request.status >= 400) {
			throw new GetNoteApiError({ message: `Download failed (HTTP ${request.status})`, httpStatus: request.status });
		}
		return request.text;
	}

	async fetchBinary(url: string, authenticated = false): Promise<ArrayBuffer> {
		const request = await requestUrl({
			url,
			method: 'GET',
			headers: authenticated ? this.authHeaders() : {},
			throw: false,
		});
		if (request.status >= 400) {
			throw new GetNoteApiError({ message: `Download failed (HTTP ${request.status})`, httpStatus: request.status });
		}
		return request.arrayBuffer;
	}

	private authHeaders(): Record<string, string> {
		const credentials = this.readCredentials();
		return {
			Authorization: credentials.apiKey.trim(),
			'X-Client-ID': credentials.clientId.trim(),
		};
	}

	private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
		const base = normaliseApiBase(this.readCredentials().apiBase);
		const url = new URL(`${base}${path}`);
		if (query) {
			for (const [key, value] of Object.entries(query)) {
				if (value === undefined || value === '' || value === null) continue;
				url.searchParams.set(key, String(value));
			}
		}
		return url.toString();
	}

	private async sendWithRetry(path: string, options: ApiRequestOptions) {
		if (this.blockedReason.length > 0) {
			throw new GetNoteApiError({
				message:
					this.blockedReason === 'not_member'
						? '得到大脑 OpenAPI 仅对会员开放。'
						: `接口配额已用尽（${this.blockedReason}），请等待配额重置。`,
				reason: this.blockedReason,
			});
		}
		let attempt = 0;
		let delayMs = 1000;
		for (;;) {
			const request = await requestUrl({
				url: this.buildUrl(path, options.query),
				method: options.method ?? 'GET',
				headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				throw: false,
			});
			const retryableStatus = request.status === 429 || request.status >= 500;
			if (!retryableStatus || attempt >= 3) {
				return { status: request.status, headers: request.headers, text: request.text };
			}
			attempt++;
			await pause(delayMs);
			delayMs *= 2;
		}
	}

	private toApiError(payload: Record<string, unknown> | null, httpStatus: number, headers: Record<string, string>): GetNoteApiError {
		const rawError = (payload?.error ?? null) as Record<string, unknown> | null;
		const requestId = String(payload?.request_id ?? headers['x-request-id'] ?? '');
		if (!rawError) {
			return new GetNoteApiError({
				message: httpStatus === 401 ? '鉴权失败：请检查 API Key 与 Client ID。' : `请求失败（HTTP ${httpStatus}）。`,
				httpStatus,
				requestId,
			});
		}
		const rateLimit = parseQuotaSnapshot(rawError.rate_limit);
		if (rateLimit) this.publishQuota(rateLimit);
		const reason = String(rawError.reason ?? '');
		const error = new GetNoteApiError({
			message: String(rawError.message ?? reason ?? '请求失败'),
			code: Number(rawError.code ?? 0) || 0,
			reason,
			retryable: rawError.retryable === true,
			httpStatus,
			requestId,
			rateLimit,
		});
		if (error.isQuotaExhausted || error.isNotMember) this.blockedReason = reason || 'quota_day';
		return error;
	}

	private publishQuota(quota: QuotaSnapshot): void {
		this.quota = quota;
		for (const listener of this.quotaListeners) listener(quota);
	}

	/** Endpoints report quota after `GET /resource/rate-limit/quota`. */
	reportQuota(quota: QuotaSnapshot | null): void {
		if (quota) this.publishQuota(quota);
	}
}
