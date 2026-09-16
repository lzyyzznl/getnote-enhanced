import { App } from 'obsidian';

import { ApiClient } from './api/client';
import { GetNoteEndpoints } from './api/endpoints';
import { PullEngine } from './sync/pull';
import { PushEngine } from './sync/push';
import { ContentEngine } from './sync/content';
import { GetNoteChannelSettings } from './types';

/**
 * Surface the GetNote channel exposes to its UI. `main.ts` implements it; every
 * module under `src/` depends on this interface, never on the plugin class.
 */
export interface GetNotePluginHost {
	app: App;
	/** Settings owned by this channel, persisted in the plugin's `data.json`. */
	getNoteSettings: GetNoteChannelSettings;
	apiClient: ApiClient;
	endpoints: GetNoteEndpoints;
	pull: PullEngine;
	push: PushEngine;
	/** Imports knowledge-base blogger posts and live sessions, which are not notes. */
	content: ContentEngine;
	saveSettings(): Promise<void>;
	/** Called by UI after credentials change so transport state is rebuilt. */
	refreshCredentials(): void;
}

export const RECALL_VIEW_TYPE = 'getnote-recall-view';
export const QUOTA_VIEW_TYPE = 'getnote-quota-view';
export const KB_VIEW_TYPE = 'getnote-kb-view';
