/**
 * Minimal Obsidian runtime for the headless smoke harness.
 *
 * The plugin's `src/` tree is bundled against this file instead of the real
 * `obsidian` package, so the API, render and sync code paths can be exercised
 * against the live service from a plain Node process. UI classes are inert.
 */
import { promises as fs, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';

export async function requestUrl(options) {
	// Obsidian's `contentType` sets the request content type; the stub honours it so
	// multipart uploads carry their boundary exactly as they do in the app.
	const requestHeaders = { ...(options.headers ?? {}) };
	if (options.contentType !== undefined) requestHeaders['Content-Type'] = options.contentType;
	const response = await fetch(options.url, {
		method: options.method ?? 'GET',
		headers: requestHeaders,
		body: options.body,
	});
	const headers = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	const buffer = await response.arrayBuffer();
	const text = new TextDecoder().decode(buffer);
	return {
		status: response.status,
		headers,
		text,
		arrayBuffer: buffer,
		// Mirrors the real `RequestUrlResponse`: parsing is lazy, so binary
		// payloads do not explode before the caller asks for them.
		json: () => JSON.parse(text),
	};
}

export function normalizePath(value) {
	return value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
}

export class Notice {
	constructor(message) {
		this.message = message;
		this.hidden = false;
		// eslint-disable-next-line no-console
		console.log(`[notice] ${message}`);
	}
	setMessage(message) {
		this.message = message;
		console.log(`[notice] ${message}`);
	}
	hide() {
		this.hidden = true;
	}
}

export class TFile {
	constructor(path) {
		this.path = path;
		this.name = path.split('/').pop() ?? path;
		this.basename = this.name.replace(/\.[^.]+$/, '');
		this.extension = this.name.split('.').pop() ?? '';
	}
}

export class TFolder {
	constructor(path) {
		this.path = path;
	}
}

export class Component {
	load() {}
	unload() {}
	registerEvent() {}
	registerInterval() {}
	addChild() {}
}

export class Setting {
	constructor() {}
	setName() {
		return this;
	}
	setDesc() {
		return this;
	}
	addText(callback) {
		callback({
			setPlaceholder() {
				return this;
			},
			setValue() {
				return this;
			},
			onChange() {
				return this;
			},
		});
		return this;
	}
	addToggle(callback) {
		return this.addText(callback);
	}
	addDropdown(callback) {
		return this.addText(callback);
	}
	addSlider(callback) {
		return this.addText(callback);
	}
	addButton(callback) {
		callback({ setButtonText() { return this; }, setCta() { return this; }, onClick() { return this; } });
		return this;
	}
}

export class PluginSettingTab {
	constructor(app, plugin) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = { empty() {}, createEl() { return { createEl() {} }; } };
	}
	display() {}
}

export class ItemView {
	constructor(leaf) {
		this.leaf = leaf;
		this.containerEl = createContainerEl();
		this.contentEl = this.containerEl;
	}
	getViewType() {
		return 'stub-view';
	}
	getDisplayText() {
		return 'stub';
	}
	getIcon() {
		return 'file';
	}
	onOpen() {
		return Promise.resolve();
	}
	onClose() {
		return Promise.resolve();
	}
}

export class Modal {
	constructor(app) {
		this.app = app;
		this.contentEl = createContainerEl();
	}
	open() {
		this.onOpen();
	}
	close() {
		this.onClose();
	}
	onOpen() {}
	onClose() {}
}

export class SuggestModal extends Modal {
	setPlaceholder() {}
	getSuggestions() {
		return [];
	}
	renderSuggestion() {}
}

function createContainerEl() {
	const element = {
		children: [],
		textContent: '',
		empty() {
			element.children = [];
			element.textContent = '';
		},
		createEl(tag, options) {
			const child = createContainerEl();
			child.tag = tag;
			child.textContent = options?.text ?? '';
			element.children.push(child);
			element.textContent += child.textContent;
			return child;
		},
		createDiv(options) {
			return element.createEl('div', options);
		},
		addClass() {},
		setAttr() {},
		appendChild(child) {
			element.children.push(child);
			return child;
		},
	};
	return element;
}

export const Platform = { isDesktopApp: true, isMobileApp: false, isMobile: false };

export function addIcon() {}

export class Plugin extends Component {
	constructor(app, manifest) {
		super();
		this.app = app;
		this.manifest = manifest;
	}
	addRibbonIcon() {
		return createContainerEl();
	}
	addCommand() {}
	addSettingTab() {}
	registerView() {}
	async loadData() {
		return this.__data ?? null;
	}
	async saveData(data) {
		this.__data = data;
	}
}

export class App {}

/** Filesystem-backed vault used by the harness; paths are vault-relative. */
export function createVaultBackedApp(rootDir) {
	const absolute = (path) => nodePath.join(rootDir, normalizePath(path));
	const stats = async (path) => {
		try {
			return await fs.stat(absolute(path));
		} catch {
			return null;
		}
	};
	const vault = {
		getAbstractFileByPath(path) {
			const normalised = normalizePath(path);
			if (vault.__files.has(normalised)) return new TFile(normalised);
			if (vault.__folders.has(normalised)) return new TFolder(normalised);
			return null;
		},
		async createFolder(path) {
			const normalised = normalizePath(path);
			await fs.mkdir(absolute(normalised), { recursive: true });
			vault.__folders.add(normalised);
		},
		async create(path, data) {
			const normalised = normalizePath(path);
			await fs.mkdir(nodePath.dirname(absolute(normalised)), { recursive: true });
			await fs.writeFile(absolute(normalised), data, 'utf8');
			vault.__files.add(normalised);
			if (data === null) {
				const binary = new Uint8Array();
				await fs.writeFile(absolute(normalised), binary);
			}
			return new TFile(normalised);
		},
		async createBinary(path, data) {
			const normalised = normalizePath(path);
			await fs.mkdir(nodePath.dirname(absolute(normalised)), { recursive: true });
			await fs.writeFile(absolute(normalised), Buffer.from(data));
			vault.__files.add(normalised);
			return new TFile(normalised);
		},
		async read(file) {
			const path = typeof file === 'string' ? file : file.path;
			return fs.readFile(absolute(path), 'utf8');
		},
		async readBinary(file) {
			const path = typeof file === 'string' ? file : file.path;
			const bytes = await fs.readFile(absolute(path));
			// The real API hands back an ArrayBuffer, which is what uploads expect.
			return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		},
		async cachedRead(file) {
			return vault.read(file);
		},
		async modify(file, data) {
			const path = typeof file === 'string' ? file : file.path;
			await fs.writeFile(absolute(path), data, 'utf8');
			vault.__files.add(normalizePath(path));
		},
		async append(file, data) {
			const path = typeof file === 'string' ? file : file.path;
			await fs.appendFile(absolute(path), data, 'utf8');
		},
		async delete(file) {
			const path = typeof file === 'string' ? file : file.path;
			await fs.rm(absolute(path), { force: true });
			vault.__files.delete(normalizePath(path));
		},
		async exists(path) {
			return (await stats(path)) !== null;
		},
		getMarkdownFiles() {
			return [...vault.__files].filter((path) => path.endsWith('.md')).map((path) => new TFile(path));
		},
		getFiles() {
			return [...vault.__files].map((path) => new TFile(path));
		},
		__files: new Set(),
		__folders: new Set(),
	};
	vault.adapter = {
		async write(path, data) {
			await fs.mkdir(nodePath.dirname(absolute(path)), { recursive: true });
			await fs.writeFile(absolute(path), data, 'utf8');
			vault.__files.add(normalizePath(path));
		},
		async writeBinary(path, data) {
			await fs.mkdir(nodePath.dirname(absolute(path)), { recursive: true });
			await fs.writeFile(absolute(path), Buffer.from(data));
			vault.__files.add(normalizePath(path));
		},
		async read(path) {
			return fs.readFile(absolute(path), 'utf8');
		},
		async readBinary(path) {
			return fs.readFile(absolute(path));
		},
		async exists(path) {
			return (await stats(path)) !== null;
		},
		async mkdir(path) {
			await fs.mkdir(absolute(path), { recursive: true });
			vault.__folders.add(normalizePath(path));
		},
		async remove(path) {
			await fs.rm(absolute(path), { force: true, recursive: true });
			vault.__files.delete(normalizePath(path));
		},
	};
	const metadataCache = {
		/**
		 * Obsidian indexes frontmatter in memory; the stand-in parses the leading
		 * block on demand. Values stay raw text, which is what the sync engine
		 * treats as authoritative for snowflake ids anyway.
		 */
		getFileCache(file) {
			if (!vault.__files.has(normalizePath(file.path))) return null;
			const text = readFileSync(absolute(file.path), 'utf8');
			const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(text);
			if (!block) return {};
			const frontmatter = {};
			for (const line of block[1].split('\n')) {
				const match = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*?)[ \t\r]*$/.exec(line);
				if (match) frontmatter[match[1]] = match[2].replace(/^["']|["']$/g, '');
			}
			return { frontmatter };
		},
		getFirstLinkpathDest(linkpath) {
			const direct = normalizePath(linkpath);
			// `![[pic.png]]` resolves to a real file; a bare `[[note]]` falls back to `.md`.
			if (vault.__files.has(direct)) return new TFile(direct);
			const target = normalizePath(`${linkpath}.md`);
			return vault.__files.has(target) ? new TFile(target) : null;
		},
	};
	const workspace = {
		getActiveFile() {
			return null;
		},
		getLeaf() {
			return { openFile: async () => undefined, setViewState: async () => undefined };
		},
		getRightLeaf() {
			return { setViewState: async () => undefined };
		},
		getLeavesOfType() {
			return [];
		},
		revealLeaf() {},
		onLayoutReady(callback) {
			callback();
		},
		on() {
			return {};
		},
		detachLeavesOfType() {},
	};
	const app = { vault, metadataCache, workspace };
	return app;
}
