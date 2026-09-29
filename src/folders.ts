import { App, Component, Keymap, TAbstractFile, TFile, TFolder, debounce, getFrontMatterInfo, parseYaml } from "obsidian";
import { companionRename, cssString, folderPagePath, isFolderPage, mirrorOf, wikiFolderOf } from "./helpers";

const SCOPE_TYPES = new Set(["area", "repository"]);

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Scope folders in the file explorer. A folder of the wiki that holds a page of its own
 * name, of type area or repository, is a scope: clicking its name opens that page, the page
 * itself hides inside it, and renaming the folder or the page renames the other. The
 * explorer's DOM is not public API, so every step tolerates a missing element.
 */
export class ScopeFolders extends Component {
	private style: HTMLStyleElement | null = null;
	private enabled = false;
	private scopes = new Set<string>();
	readonly refresh = debounce(() => this.apply(), 300, true);

	constructor(private app: App, private onMove: () => void) {
		super();
	}

	onload(): void {
		this.style = document.head.createEl("style", { attr: { id: "atlas-scope-folders" } });
		this.registerEvent(this.app.metadataCache.on("changed", () => this.refresh()));
		this.registerEvent(this.app.metadataCache.on("resolved", () => this.refresh()));
		this.registerEvent(this.app.vault.on("delete", () => this.refresh()));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.refresh();
				const moved = (p: string) => p.startsWith("wiki/") || p.startsWith("threads/");
				if (!moved(file.path) && !moved(oldPath)) return;
				void this.follow(file instanceof TFolder, file.path, oldPath).finally(() => this.onMove());
			}),
		);
		// The explorer handles a click on a folder itself, so the listener runs first.
		this.registerDomEvent(document, "click", (evt) => this.onClick(evt), { capture: true });
		this.app.workspace.onLayoutReady(() => this.refresh());
	}

	onunload(): void {
		this.style?.remove();
		this.style = null;
	}

	setEnabled(on: boolean): void {
		this.enabled = on;
		this.apply();
	}

	private isScopePage(file: TFile): boolean {
		const type = this.app.metadataCache.getFileCache(file)?.frontmatter?.type;
		return typeof type === "string" && SCOPE_TYPES.has(type);
	}

	/** The page that makes a folder a scope, or null. A folder of threads/ stands for the
	 * scope folder of the wiki at the same place. */
	private pageOf(folder: string): TFile | null {
		const path = folderPagePath(wikiFolderOf(folder));
		const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
		return file instanceof TFile && this.isScopePage(file) ? file : null;
	}

	private apply(): void {
		this.scopes.clear();
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!isFolderPage(file.path) || !this.isScopePage(file)) continue;
			const folder = file.parent?.path ?? "";
			this.scopes.add(folder);
			const mirror = mirrorOf(folder);
			if (this.app.vault.getAbstractFileByPath(mirror) instanceof TFolder) this.scopes.add(mirror);
		}
		if (!this.style) return;
		const rules: string[] = [];
		for (const folder of this.scopes) {
			rules.push(`.nav-folder-title[data-path=${cssString(folder)}] .nav-folder-title-content { font-weight: var(--font-semibold); }`);
			if (this.enabled) {
				rules.push(`.nav-folder-title[data-path=${cssString(folder)}] { cursor: pointer; }`);
				if (folder.startsWith("wiki/")) rules.push(`.nav-file-title[data-path=${cssString(folderPagePath(folder) ?? "")}] { display: none; }`);
			}
		}
		this.style.textContent = rules.join("\n");
	}

	private onClick(evt: MouseEvent): void {
		if (!this.enabled || !(evt.target instanceof Element)) return;
		if (evt.target.closest(".nav-folder-collapse-indicator")) return;
		const title = evt.target.closest<HTMLElement>(".nav-folder-title");
		const folder = title?.getAttribute("data-path") ?? "";
		if (!this.scopes.has(folder)) return;
		const page = this.pageOf(folder);
		if (page) void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(page);
	}

	/** Renames the folder or the page that must follow the user's rename. */
	private async readsAsScopePage(file: TFile): Promise<boolean> {
		if (this.isScopePage(file)) return true;
		const info = getFrontMatterInfo(await this.app.vault.cachedRead(file));
		if (!info.exists) return false;
		try {
			const type = (parseYaml(info.frontmatter) as { type?: unknown } | null)?.type;
			return typeof type === "string" && SCOPE_TYPES.has(type);
		} catch {
			return false;
		}
	}

	private async follow(isFolder: boolean, path: string, oldPath: string): Promise<void> {
		const next = companionRename(isFolder, path, oldPath);
		if (!next) return;
		// Obsidian moves a folder's children after it reports the folder's rename.
		let from = this.app.vault.getAbstractFileByPath(next.from);
		for (let i = 0; !from && i < 20; i++) {
			await wait(50);
			from = this.app.vault.getAbstractFileByPath(next.from);
		}
		if (!from || this.app.vault.getAbstractFileByPath(next.to)) return;
		const page = isFolder ? from : this.app.vault.getAbstractFileByPath(path);
		if (!(page instanceof TFile) || (!isFolder && !(from instanceof TFolder))) return;
		// Right after a rename the metadata cache may not know the new path yet.
		if (!(await this.readsAsScopePage(page))) return;
		await this.renameKeepingLinks(from, next.to);
	}

	/**
	 * Renames a file or folder and updates the links to it, whatever the user's setting for
	 * links says: a link names a title, so a title that changes without its links breaks
	 * them. The setting is not public API; without it the rename follows the setting.
	 */
	private async renameKeepingLinks(file: TAbstractFile, to: string): Promise<void> {
		const vault = this.app.vault as unknown as { getConfig?: (k: string) => unknown; setConfig?: (k: string, v: unknown) => void };
		const was = vault.getConfig?.("alwaysUpdateLinks");
		if (was === false) vault.setConfig?.("alwaysUpdateLinks", true);
		try {
			await this.app.fileManager.renameFile(file, to);
		} finally {
			if (was === false) vault.setConfig?.("alwaysUpdateLinks", false);
		}
	}
}
