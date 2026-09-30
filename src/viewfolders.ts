import { App, Component, Keymap, TFile, debounce } from "obsidian";
import { cssString, isTagView, tagOfFolder, tagViewPath } from "./helpers";

/**
 * The tag tree of views/ in the file explorer. A folder under views/tags stands for a
 * tag: its name is bold, a click on it opens the tag's view note, and the note hides
 * inside it. The explorer's DOM is not public API, so every step tolerates a missing
 * element.
 */
export class ViewFolders extends Component {
	private style: HTMLStyleElement | null = null;
	private enabled = false;
	readonly refresh = debounce(() => this.apply(), 300, true);

	constructor(private app: App) {
		super();
	}

	onload(): void {
		this.style = document.head.createEl("style", { attr: { id: "atlas-view-folders" } });
		this.registerEvent(this.app.vault.on("create", () => this.refresh()));
		this.registerEvent(this.app.vault.on("delete", () => this.refresh()));
		this.registerEvent(this.app.vault.on("rename", () => this.refresh()));
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

	private apply(): void {
		if (!this.style) return;
		const rules = [
			`.nav-folder-title[data-path^="views/tags/"] .nav-folder-title-content { font-weight: var(--font-semibold); }`,
		];
		if (this.enabled) {
			rules.push(`.nav-folder-title[data-path^="views/tags/"] { cursor: pointer; }`);
			for (const file of this.app.vault.getMarkdownFiles()) {
				if (isTagView(file.path)) rules.push(`.nav-file-title[data-path=${cssString(file.path)}] { display: none; }`);
			}
		}
		this.style.textContent = rules.join("\n");
	}

	private onClick(evt: MouseEvent): void {
		if (!this.enabled || !(evt.target instanceof Element)) return;
		if (evt.target.closest(".nav-folder-collapse-indicator")) return;
		const title = evt.target.closest<HTMLElement>(".nav-folder-title");
		const tag = tagOfFolder(title?.getAttribute("data-path") ?? "");
		if (!tag) return;
		const note = this.app.vault.getAbstractFileByPath(tagViewPath(tag));
		if (note instanceof TFile) void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(note);
	}
}
