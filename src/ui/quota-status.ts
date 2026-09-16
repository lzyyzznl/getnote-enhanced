import { Notice, Setting } from 'obsidian';

import { GetNoteApiError } from '../api/client';
import { GetNotePluginHost } from '../host';
import { QuotaSnapshot, QuotaWindow } from '../types';

const WARN_RATIO = 0.2;
/** Epoch timestamps are far above this; smaller values are seconds-from-now. */
const EPOCH_THRESHOLD = 1e9;

/** Names the epoch-vs-duration heuristic and the day/hour split for a reset stamp. */
function formatReset(resetAt: number, now: number): string {
	if (resetAt <= 0) return '未知';
	const target = resetAt >= EPOCH_THRESHOLD ? (resetAt < 1e12 ? resetAt * 1000 : resetAt) : now + resetAt * 1000;
	const minutes = Math.round((target - now) / 60_000);
	if (minutes <= 0) return '已重置';
	if (minutes < 60) return `${minutes} 分钟`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
	return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

/** One-line summary of the daily budgets, for use inside a `Notice`. */
export function formatQuotaLine(quota: QuotaSnapshot): string {
	return [
		`读取 ${quota.read.daily.used}/${quota.read.daily.limit}`,
		`写入 ${quota.write.daily.used}/${quota.write.daily.limit}`,
		`写笔记 ${quota.writeNote.daily.used}/${quota.writeNote.daily.limit}`,
	].join(' · ');
}

/**
 * Renders the cached quota snapshot, fetching one when the client has none yet.
 * The panel owns the whole container: calling it again rebuilds it in place.
 */
export async function renderQuotaPanel(container: HTMLElement, host: GetNotePluginHost): Promise<void> {
	container.empty();
	const now = Date.now();
	let quota = host.apiClient.getQuota();
	let failure = '';
	if (!quota) {
		try {
			quota = await host.endpoints.getQuota();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failure =
				error instanceof GetNoteApiError && error.requestId.length > 0 ? `${message}（request_id: ${error.requestId}）` : message;
		}
	}

	container.createEl('h4', { text: '接口配额' });
	if (!quota) {
		container.createEl('p', {
			cls: 'getnote-quota-empty',
			text: failure.length > 0 ? `配额读取失败：${failure}` : '尚未获取配额信息，点击下方按钮刷新。',
		});
	} else {
		const rows: Array<{ label: string; window: QuotaWindow }> = [
			{ label: '读取', window: quota.read },
			{ label: '写入', window: quota.write },
			{ label: '写笔记', window: quota.writeNote },
			{ label: 'AI 对话', window: quota.aiChat },
		];
		const table = container.createEl('table', { cls: 'getnote-quota-table' });
		const headRow = table.createEl('thead').createEl('tr');
		for (const heading of ['额度', '今日', '本月', '重置']) headRow.createEl('th', { text: heading });
		const body = table.createEl('tbody');
		for (const row of rows) {
			const dailyRatio = row.window.daily.limit > 0 ? row.window.daily.remaining / row.window.daily.limit : 1;
			const monthlyRatio = row.window.monthly.limit > 0 ? row.window.monthly.remaining / row.window.monthly.limit : 1;
			const remainingRatio = Math.min(dailyRatio, monthlyRatio);
			const level = remainingRatio <= 0 ? 'exhausted' : remainingRatio < WARN_RATIO ? 'warn' : 'ok';
			const tableRow = body.createEl('tr', { cls: `getnote-quota-${level}` });
			tableRow.createEl('td', { text: row.label });
			tableRow.createEl('td', { text: `${row.window.daily.used}/${row.window.daily.limit}` });
			tableRow.createEl('td', { text: `${row.window.monthly.used}/${row.window.monthly.limit}` });
			tableRow.createEl('td', { text: formatReset(row.window.daily.resetAt, now) });
		}
		container.createEl('p', { cls: 'getnote-quota-summary', text: formatQuotaLine(quota) });
	}

	new Setting(container).addButton((button) => {
		button.setButtonText('刷新配额').onClick(async () => {
			button.setDisabled(true);
			let refreshFailure = '';
			try {
				await host.endpoints.getQuota();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				refreshFailure =
					error instanceof GetNoteApiError && error.requestId.length > 0
						? `${message}（request_id: ${error.requestId}）`
						: message;
			}
			await renderQuotaPanel(container, host);
			if (refreshFailure.length > 0) new Notice(`配额刷新失败：${refreshFailure}`);
		});
	});
}
