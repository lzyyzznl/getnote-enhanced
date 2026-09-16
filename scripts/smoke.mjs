/**
 * Runs `scripts/smoke-entry.mjs` against the live GetNote OpenAPI.
 *
 * The scenario is bundled with `obsidian` aliased to `scripts/obsidian-stub.mjs`
 * and executed in a temporary directory, so no build output or vault state is
 * touched.
 *
 * Usage:
 *   GETNOTE_API_KEY=gk_live_xxx GETNOTE_CLIENT_ID=cli_xxx \
 *   GETNOTE_SMOKE_VAULT=/tmp/getnote-vault node scripts/smoke.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import esbuild from 'esbuild';

const root = process.cwd();
const workdir = await mkdtemp(path.join(os.tmpdir(), 'getnote-smoke-'));
const outfile = path.join(workdir, 'smoke.mjs');

// The plugin code schedules timers through `window`, which Node does not define.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

try {
	await esbuild.build({
		entryPoints: [path.join(root, 'scripts/smoke-entry.mjs')],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node20',
		outfile,
		logLevel: 'warning',
		alias: { obsidian: path.join(root, 'scripts', 'obsidian-stub.mjs') },
	});
	await import(pathToFileURL(outfile).href);
} finally {
	await rm(workdir, { recursive: true, force: true });
}
