import { App, ItemView, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { DOCUMENTS, TagDoc, asList, groupDocs, isDocumentType, narrow, normalTag, relativeTag, tagViewPath, topTags } from "./helpers";
import { markdownFilesIn } from "./vaultfiles";

export const TAG_NAV_VIEW = "almagest-tag-navigator";
/** Not "tags", which is the icon of Obsidian's own Tags pane. */
export const NAV_ICON = "compass";

const MAX_WITH = 30;

/** Every document of source-core/documents, as the navigator reads it from the metadata cache. */
export function tagDocs(app: App): TagDoc[] {
	const out: TagDoc[] = [];
	for (const file of markdownFilesIn(app, DOCUMENTS)) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || !isDocumentType(fm.type)) continue;
		const own = asList(fm.tags).map(normalTag);
		if (typeof fm.defines === "string" && fm.defines) own.push(normalTag(fm.defines));
		out.push({
			path: file.path,
			title: file.basename,
			type: String(fm.type),
			kind: String(fm.kind ?? ""),
			status: String(fm.status ?? ""),
			description: String(fm.description ?? ""),
			tags: own,
		});
	}
	return out;
}

/**
 * The Almagest navigator: pick a tag, then the tags that occur with it, to any depth; below,
 * the documents that hold every chosen tag. It reads the metadata cache and writes
 * nothing.
 */
export class TagNavigator extends ItemView {
	private chosen: string[] = [];
	private readonly rerender = debounce(() => this.render(), 500, true);

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return TAG_NAV_VIEW;
	}

	getDisplayText(): string {
		return "Almagest navigator";
	}

	getIcon(): string {
		return NAV_ICON;
	}

	getState(): Record<string, unknown> {
		return { chosen: this.chosen };
	}

	async setState(state: unknown, result: unknown): Promise<void> {
		const s = state as { chosen?: unknown } | null;
		if (s && Array.isArray(s.chosen)) this.chosen = s.chosen.filter((t): t is string => typeof t === "string");
		this.render();
		await super.setState(state, result as never);
	}

	async onOpen(): Promise<void> {
		this.registerEvent(this.app.metadataCache.on("resolved", () => this.rerender()));
		this.registerEvent(this.app.vault.on("rename", () => this.rerender()));
		this.render();
	}

	private add(tag: string): void {
		if (!this.chosen.includes(tag)) this.chosen.push(tag);
		this.render();
	}

	private drop(tag: string): void {
		this.chosen = this.chosen.filter((t) => t !== tag);
		this.render();
	}

	render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("almagest-tagnav");
		const docs = tagDocs(this.app);
		const path = root.createDiv({ cls: "almagest-tagnav-path" });
		const home = path.createEl("button", { cls: "almagest-tagnav-home", text: "All tags" });
		home.onclick = () => {
			this.chosen = [];
			this.render();
		};
		for (const t of this.chosen) {
			const chip = path.createSpan({ cls: "almagest-tagnav-chip" });
			chip.createSpan({ text: "#" + t });
			chip.setAttr("title", "#" + t);
			const x = chip.createEl("button", { cls: "almagest-tagnav-x", text: "×", attr: { "aria-label": `Remove ${t}` } });
			x.onclick = () => this.drop(t);
		}
		if (this.chosen.length === 0) {
			root.createDiv({ cls: "almagest-tagnav-hint", text: "Choose a tag, then narrow by the tags that occur with it." });
			const list = this.section(root, "Tags");
			for (const f of topTags(docs)) this.tagButton(list, f.tag, f.count);
			if (docs.length === 0) root.createDiv({ cls: "almagest-tagnav-empty", text: "No document holds a tag yet." });
			return;
		}
		const { matches, with: facets } = narrow(docs, this.chosen);
		const count = `${matches.length} ${matches.length === 1 ? "document holds" : "documents hold"} ${this.chosen.length === 1 ? "this tag" : this.chosen.length === 2 ? "both tags" : `all ${this.chosen.length} tags`}`;
		root.createDiv({ cls: "almagest-tagnav-count", text: count });
		const view = this.section(root, "View");
		const page = view.createEl("button", { text: "Tag view" });
		const last = this.chosen[this.chosen.length - 1] ?? "";
		page.setAttr("aria-label", "Open the view of #" + last);
		page.onclick = () => void this.openView(last);
		if (facets.length > 0) {
			const list = this.section(root, "Narrow");
			for (const f of facets.slice(0, MAX_WITH)) this.tagButton(list, f.tag, f.count, relativeTag(f.tag, this.chosen));
		}
		for (const group of groupDocs(matches)) {
			const g = root.createDiv({ cls: "almagest-tagnav-group" });
			g.createDiv({ cls: "almagest-tagnav-group-name", text: `${group.name} (${group.docs.length})` });
			for (const d of group.docs) {
				const row = g.createDiv({ cls: "almagest-tagnav-doc" });
				row.dataset.type = d.type;
				row.setAttr("title", d.description);
				row.createSpan({ cls: "almagest-tagnav-doc-title", text: d.title });
				const meta = [d.kind || d.type, d.status].filter((x) => x).join(" · ");
				row.createSpan({ cls: "almagest-tagnav-doc-meta", text: meta });
				row.onclick = (evt) => {
					const file = this.app.vault.getAbstractFileByPath(d.path);
					if (file instanceof TFile) void this.app.workspace.getLeaf(evt.metaKey || evt.ctrlKey).openFile(file);
				};
			}
		}
	}

	/** A labeled section; returns the element its items go in. */
	private section(root: HTMLElement, label: string): HTMLElement {
		const el = root.createDiv({ cls: "almagest-tagnav-section" });
		el.createDiv({ cls: "almagest-tagnav-label", text: label });
		return el.createDiv({ cls: "almagest-tagnav-items" });
	}

	private tagButton(parent: HTMLElement, tag: string, count: number, label = "#" + tag): void {
		const b = parent.createEl("button", { cls: "almagest-tagnav-tag" });
		b.createSpan({ text: label });
		b.setAttr("title", "#" + tag);
		b.createSpan({ cls: "almagest-tagnav-tag-count", text: String(count) });
		b.onclick = () => this.add(tag);
	}

	private async openView(tag: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(tagViewPath(tag));
		if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
	}
}
