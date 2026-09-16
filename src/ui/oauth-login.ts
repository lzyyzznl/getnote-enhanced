import { App, Modal, Notice } from 'obsidian';

import { GetNoteApiError } from '../api/client';
import { GetNotePluginHost } from '../host';
import { DeviceCodeChallenge, DeviceCredentials } from '../types';

/** Human readable error text; `request_id` is appended when the API sent one. */
function failureMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return error instanceof GetNoteApiError && error.requestId.length > 0
		? `${message}（request_id: ${error.requestId}）`
		: message;
}

/**
 * 设备流只能用用户自己的应用凭证：Client ID 由开放平台创建应用时签发，
 * 插件不能替用户创建，也不该内置一个公共 Client ID（授权会落到别人名下）。
 */
const MISSING_CLIENT_ID =
	'缺少 Client ID：浏览器授权需要先在得到大脑开放平台创建应用，把应用详情页的 cli_xxx 填到「Client ID」后再试；不创建应用仍然可以用 API Key 登录。';

/** 服务端一般会给出 interval；缺失时按 5 秒轮询，这个间隔不会被判为过频。 */
const POLL_INTERVAL_FALLBACK_SECONDS = 5;

/** `expires_at` 是秒级时间戳，用户只需要知道日期。 */
function formatExpiry(expiresAt: number): string {
	if (!Number.isFinite(expiresAt) || expiresAt <= 0) return '未知';
	const expires = new Date(expiresAt * 1000);
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `${expires.getFullYear()}-${pad(expires.getMonth() + 1)}-${pad(expires.getDate())}`;
}

/**
 * 设备码弹窗：展示 user_code 与验证地址，并按服务端 interval 轮询到 expires_in 为止。
 * 轮询循环由弹窗持有，关闭窗口即停止，避免后台继续请求过期设备码。
 */
class DeviceLoginModal extends Modal {
	private readonly host: GetNotePluginHost;
	private readonly clientId: string;
	private readonly challenge: DeviceCodeChallenge;
	private readonly deadline: number;
	private statusEl: HTMLElement | null = null;
	private timer: number | null = null;
	/** 关闭后到达的轮询结果既不能再排下一次，也不能再写设置。 */
	private closed = false;

	constructor(app: App, host: GetNotePluginHost, clientId: string, challenge: DeviceCodeChallenge) {
		super(app);
		this.host = host;
		this.clientId = clientId;
		this.challenge = challenge;
		this.deadline = Date.now() + challenge.expiresIn * 1000;
	}

	override onOpen(): void {
		this.contentEl.createEl('h2', { text: '浏览器授权' });
		this.contentEl.createEl('p', {
			text: '在浏览器打开的页面里确认下面的授权码；本窗口保持打开，授权成功后会自动关闭。',
		});
		this.contentEl.createDiv({ cls: 'getnote-oauth-code', text: this.challenge.userCode });
		this.contentEl.createDiv({ cls: 'getnote-oauth-uri', text: this.challenge.verificationUri });

		const openButton = this.contentEl.createEl('button', { cls: 'mod-cta', text: '打开授权页面' });
		openButton.addEventListener('click', () => {
			window.open(this.challenge.verificationUri, '_blank');
		});

		this.statusEl = this.contentEl.createDiv({ cls: 'getnote-oauth-status', text: '等待授权…' });
		this.schedule();
	}

	override onClose(): void {
		this.closed = true;
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		this.contentEl.empty();
	}

	private setStatus(text: string, error = false): void {
		if (!this.statusEl) return;
		this.statusEl.setText(text);
		this.statusEl.toggleClass('getnote-oauth-error', error);
	}

	/** 第一次轮询也等一个 interval，服务端按间隔下发设备码状态。 */
	private schedule(): void {
		if (this.closed) return;
		const seconds = this.challenge.interval > 0 ? this.challenge.interval : POLL_INTERVAL_FALLBACK_SECONDS;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.poll();
		}, seconds * 1000);
	}

	private async poll(): Promise<void> {
		if (this.closed) return;
		try {
			const result = await this.host.endpoints.pollDeviceToken(this.clientId, this.challenge.code);
			if (this.closed) return;
			if (result.state === 'success') {
				await this.applyCredentials(result.credentials);
				return;
			}
			if (result.state === 'error') {
				this.setStatus(`授权失败：${result.message}`, true);
				return;
			}
			this.setStatus('等待授权…');
		} catch (error) {
			if (this.closed) return;
			// 设备码在 expires_in 内一直有效，单次网络失败不该中断整个授权。
			this.setStatus(`等待授权…（${failureMessage(error)}）`, true);
		}
		if (Date.now() >= this.deadline) {
			this.setStatus('授权超时：设备码已失效，请关闭本窗口后重新发起授权。', true);
			return;
		}
		this.schedule();
	}

	/** 授权成功后凭据即生效；写盘失败也要让用户知道当前只在内存里。 */
	private async applyCredentials(credentials: DeviceCredentials): Promise<void> {
		const settings = this.host.getNoteSettings;
		settings.apiKey = credentials.apiKey;
		if (credentials.clientId.length > 0) settings.clientId = credentials.clientId;
		this.host.refreshCredentials();
		try {
			await this.host.saveSettings();
		} catch (error) {
			this.setStatus(`授权成功，但设置写入失败：${failureMessage(error)}`, true);
			return;
		}
		const expiry = formatExpiry(credentials.expiresAt);
		this.setStatus(`授权成功，API Key 有效期至 ${expiry}。`);
		// 弹窗随即关闭，有效期必须用提示带出窗口，否则用户看不到。
		new Notice(`浏览器授权成功，API Key 有效期至 ${expiry}。`);
		this.close();
	}
}

/**
 * 走 OAuth 2.0 设备流换取 API Key：无回调地址，适合手机与桌面端的插件。
 * 成功时直接改写凭证并把 Client ID 一起写入设置。
 */
export async function runDeviceLogin(host: GetNotePluginHost): Promise<void> {
	const clientId = host.getNoteSettings.clientId.trim();
	if (clientId.length === 0) throw new Error(MISSING_CLIENT_ID);
	const challenge = await host.endpoints.requestDeviceCode(clientId);
	new DeviceLoginModal(host.app, host, clientId, challenge).open();
}
