import { App, ItemView, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { TagDoc, asList, groupDocs, narrow, normalTag, tagViewPath, topTags } from "./helpers";

export const TAG_NAV_VIEW = "atlas-tag-navigator";

const DOC_TYPES = new Set(["source", "repository", "topic", "stub", "spec", "event"]);
const MAX_WITH = 30;

/** Every document of wiki/documents, as the navigator reads it from the metadata cache. */
export function tagDocs(app: App): TagDoc[] {
	const out: TagDoc[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith("wiki/documents/")) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || !DOC_TYPES.has(String(fm.type))) continue;
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
 * The tag navigator: pick a tag, then the tags that occur with it, to any depth; below,
 * the documents that hold every chosen tag. It reads the metadata cache and writes
 * nothing.
 */
export class TagNavigator extends ItemView {
	private chosen: string[] = [];
	private readonly rerender = debounce(() => this.render(), 500, true);

	constructor(
		leaf: WorkspaceLeaf,
		private onChoose: (tags: string[]) => void = () => {},
		private onGraph: () => void = () => {},
	) {
		super(leaf);
	}

	getViewType(): string {
		return TAG_NAV_VIEW;
	}

	getDisplayText(): string {
		return "Atlas tags";
	}

	getIcon(): string {
		return "tags";
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

	/** Starts again at one tag. */
	show(tag: string): void {
		this.chosen = [normalTag(tag)];
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
		this.onChoose([...this.chosen]);
		const root = this.contentEl;
		root.empty();
		root.addClass("atlas-tagnav");
		const docs = tagDocs(this.app);
		const path = root.createDiv({ cls: "atlas-tagnav-path" });
		const home = path.createEl("button", { cls: "atlas-tagnav-home", text: "Tags" });
		home.onclick = () => {
			this.chosen = [];
			this.render();
		};
		for (const t of this.chosen) {
			const chip = path.createSpan({ cls: "atlas-tagnav-chip" });
			chip.createSpan({ text: "#" + t });
			const x = chip.createEl("button", { cls: "atlas-tagnav-x", text: "×", attr: { "aria-label": `Remove ${t}` } });
			x.onclick = () => this.drop(t);
		}
		if (this.chosen.length === 0) {
			const list = root.createDiv({ cls: "atlas-tagnav-tags" });
			for (const f of topTags(docs)) this.tagButton(list, f.tag, f.count);
			if (docs.length === 0) root.createDiv({ cls: "atlas-tagnav-empty", text: "No document holds a tag yet." });
			return;
		}
		const { matches, with: facets } = narrow(docs, this.chosen);
		const actions = root.createDiv({ cls: "atlas-tagnav-actions" });
		actions.createSpan({ cls: "atlas-tagnav-count", text: `${matches.length} ${matches.length === 1 ? "document" : "documents"}` });
		const search = actions.createEl("button", { text: "Search" });
		search.onclick = () => this.openSearch();
		const graph = actions.createEl("button", { text: "Graph" });
		graph.setAttr("aria-label", "Color the graph by these tags");
		graph.onclick = () => this.onGraph();
		const view = actions.createEl("button", { text: "Tag view" });
		view.setAttr("aria-label", "Open the view of " + this.chosen[0]);
		view.onclick = () => void this.openView(this.chosen[0]);
		if (facets.length > 0) {
			const withEl = root.createDiv({ cls: "atlas-tagnav-with" });
			withEl.createSpan({ cls: "atlas-tagnav-label", text: "With" });
			for (const f of facets.slice(0, MAX_WITH)) this.tagButton(withEl, f.tag, f.count);
		}
		for (const group of groupDocs(matches)) {
			const g = root.createDiv({ cls: "atlas-tagnav-group" });
			g.createDiv({ cls: "atlas-tagnav-group-name", text: `${group.name} (${group.docs.length})` });
			for (const d of group.docs) {
				const row = g.createDiv({ cls: "atlas-tagnav-doc" });
				row.dataset.type = d.type;
				row.setAttr("title", d.description);
				row.createSpan({ cls: "atlas-tagnav-doc-title", text: d.title });
				const meta = [d.kind || d.type, d.status].filter((x) => x).join(" · ");
				row.createSpan({ cls: "atlas-tagnav-doc-meta", text: meta });
				row.onclick = (evt) => {
					const file = this.app.vault.getAbstractFileByPath(d.path);
					if (file instanceof TFile) void this.app.workspace.getLeaf(evt.metaKey || evt.ctrlKey).openFile(file);
				};
			}
		}
	}

	private tagButton(parent: HTMLElement, tag: string, count: number): void {
		const b = parent.createEl("button", { cls: "atlas-tagnav-tag" });
		b.createSpan({ text: "#" + tag });
		b.setAttr("title", "#" + tag);
		b.createSpan({ cls: "atlas-tagnav-tag-count", text: String(count) });
		b.onclick = () => this.add(tag);
	}

	private openSearch(): void {
		const query = this.chosen.map((t) => `tag:#${t}`).join(" ");
		const search = (this.app as unknown as { internalPlugins?: { getPluginById?(id: string): { instance?: { openGlobalSearch?(q: string): void } } } }).internalPlugins?.getPluginById?.("global-search")?.instance;
		if (search?.openGlobalSearch) search.openGlobalSearch(query);
	}

	private async openView(tag: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(tagViewPath(tag));
		if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
	}
}
