import { App, Component, View, debounce } from "obsidian";
import {
	ColorGroup,
	GRAPH_MODES,
	GraphDoc,
	GraphMode,
	Group,
	colorGroups,
	graphGroups,
	mergeColorGroups,
} from "./graphgroups";

const BAR = "atlas-graph-colors";

// The graph's API is not public. Each access is checked, so a change in Obsidian turns
// the colors off and breaks nothing else.
interface GraphOptions {
	colorGroups?: ColorGroup[];
}
interface GraphEngine {
	getOptions(): GraphOptions;
	setOptions(options: GraphOptions): void;
}
interface GraphInstance {
	options: GraphOptions;
	saveOptions(): void;
}

function graphInstance(app: App): GraphInstance | null {
	const internal = (app as unknown as { internalPlugins?: { getPluginById?(id: string): unknown } }).internalPlugins;
	const plugin = internal?.getPluginById?.("graph") as { enabled?: boolean; instance?: GraphInstance } | undefined;
	const instance = plugin?.enabled ? plugin.instance : undefined;
	return instance && typeof instance.saveOptions === "function" && instance.options ? instance : null;
}

function engineOf(view: View): GraphEngine | null {
	const v = view as unknown as { dataEngine?: GraphEngine; engine?: GraphEngine };
	const engine = v.dataEngine ?? v.engine;
	return engine && typeof engine.setOptions === "function" && typeof engine.getOptions === "function" ? engine : null;
}

function same(a: ColorGroup[], b: ColorGroup[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export interface GraphColorsHost {
	app: App;
	settings: { graphColors: GraphMode; graphOwned: string[]; focusTags: string[] };
	saveSettings(): Promise<void>;
}

/**
 * Color groups for the graph, one mode at a time. Tag, Focus, and Type groups are search
 * queries; Work and Activity groups name their paths, so they follow every change to the
 * vault. The user's own groups stay after ours.
 */
export class GraphColors extends Component {
	private groups: Group[] = [];
	readonly refresh = debounce(() => this.apply(), 1000, true);

	constructor(private host: GraphColorsHost) {
		super();
	}

	private get app(): App {
		return this.host.app;
	}

	onload(): void {
		this.registerEvent(this.app.metadataCache.on("resolved", () => this.refresh()));
		this.registerEvent(this.app.vault.on("rename", () => this.refresh()));
		this.registerEvent(this.app.vault.on("delete", () => this.refresh()));
		this.registerEvent(this.app.workspace.on("css-change", () => this.refresh()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.refresh()));
		this.app.workspace.onLayoutReady(() => this.apply());
	}

	onunload(): void {
		this.write([]);
		for (const leaf of this.app.workspace.getLeavesOfType("graph")) {
			leaf.view.containerEl.querySelector(`.${BAR}`)?.remove();
		}
	}

	/** The tags Focus mode crosses: the Atlas navigator's choice. */
	async setFocus(tags: string[]): Promise<void> {
		if (JSON.stringify(tags) === JSON.stringify(this.host.settings.focusTags)) return;
		this.host.settings.focusTags = [...tags];
		await this.host.saveSettings();
		if (this.host.settings.graphColors === "focus") this.apply();
	}

	async setMode(mode: GraphMode): Promise<void> {
		this.host.settings.graphColors = mode;
		await this.host.saveSettings();
		this.apply();
	}

	private apply(): void {
		const mode = this.host.settings.graphColors;
		const theme = document.body.hasClass("theme-dark") ? "dark" : "light";
		const cache = this.app.metadataCache;
		this.groups =
			mode === "off"
				? []
				: graphGroups(mode, this.docs(), (link, from) => cache.getFirstLinkpathDest(link, from)?.path ?? null, theme, this.host.settings.focusTags);
		this.write(colorGroups(this.groups));
		this.renderBars();
	}

	private docs(): GraphDoc[] {
		const cache = this.app.metadataCache;
		return this.app.vault.getMarkdownFiles().map((file) => ({
			path: file.path,
			fields: cache.getFileCache(file)?.frontmatter ?? {},
			mtime: file.stat.mtime,
			links: Object.keys(cache.resolvedLinks[file.path] ?? {}),
		}));
	}

	/** Puts our groups in the graph's saved options and in every open graph. */
	private write(ours: ColorGroup[]): void {
		const instance = graphInstance(this.app);
		if (!instance) return;
		const owned = this.host.settings.graphOwned;
		const merged = mergeColorGroups(instance.options.colorGroups ?? [], ours, owned);
		if (!same(instance.options.colorGroups ?? [], merged)) {
			instance.options.colorGroups = merged;
			instance.saveOptions();
		}
		for (const type of ["graph", "localgraph"]) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				const engine = engineOf(leaf.view);
				if (!engine) continue;
				const current = engine.getOptions().colorGroups ?? [];
				const next = mergeColorGroups(current, ours, owned);
				if (!same(current, next)) engine.setOptions({ colorGroups: next });
			}
		}
		const queries = ours.map((g) => g.query);
		if (JSON.stringify(queries) !== JSON.stringify(owned)) {
			this.host.settings.graphOwned = queries;
			void this.host.saveSettings();
		}
	}

	/** The mode buttons and the legend, over each graph view. */
	private renderBars(): void {
		const mode = this.host.settings.graphColors;
		const on = graphInstance(this.app) !== null;
		for (const leaf of this.app.workspace.getLeavesOfType("graph")) {
			const content = leaf.view.containerEl.querySelector<HTMLElement>(".view-content");
			if (!content) continue;
			let bar = content.querySelector<HTMLElement>(`:scope > .${BAR}`);
			if (!on) {
				bar?.remove();
				continue;
			}
			if (!bar) bar = content.createDiv({ cls: BAR });
			bar.empty();
			const modes = bar.createDiv({ cls: "atlas-graph-modes" });
			for (const m of GRAPH_MODES) {
				const button = modes.createEl("button", { text: m.label, cls: "atlas-graph-mode" });
				button.toggleClass("is-active", m.mode === mode);
				button.setAttr("aria-pressed", String(m.mode === mode));
				button.onClickEvent(() => void this.setMode(m.mode));
			}
			if (mode === "focus" && this.host.settings.focusTags.length === 0) {
				bar.createDiv({ cls: "atlas-graph-legend-row", text: "Open the Atlas navigator (left ribbon) and choose tags to focus on them." });
				continue;
			}
			if (mode === "focus" && this.groups.length === 0) {
				bar.createDiv({ cls: "atlas-graph-legend-row", text: "No document holds all the chosen tags." });
				continue;
			}
			if (this.groups.length === 0) continue;
			const legend = bar.createDiv({ cls: "atlas-graph-legend" });
			for (const g of this.groups) {
				const row = legend.createDiv({ cls: "atlas-graph-legend-row" });
				row.createSpan({ cls: "atlas-graph-swatch" }).style.backgroundColor = g.color;
				row.createSpan({ cls: "atlas-graph-legend-name", text: g.name });
				row.createSpan({ cls: "atlas-graph-legend-count", text: String(g.paths.length) });
			}
		}
	}
}
