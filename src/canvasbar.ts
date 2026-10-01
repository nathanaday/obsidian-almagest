import { App, Component, FileView, Notice, debounce } from "obsidian";
import { CanvasState, canvasSummary, chordOfCanvas } from "./helpers";
import type AtlasPlugin from "./main";

const BAR = "atlas-canvas-bar";

/**
 * The bar over a chord's canvas. Code writes the canvas from the stubs: a card per
 * thread, an arrow per "comes after". When the user redraws it, the canvas differs from
 * the stubs, and the bar offers to save the order to the stubs or to take the stubs'
 * order back. Tidy places every card again.
 */
export class CanvasBar extends Component {
	private busy = false;
	private states = new Map<string, CanvasState | null>();
	readonly refresh = debounce(() => void this.update(), 400, true);

	constructor(private plugin: AtlasPlugin) {
		super();
	}

	private get app(): App {
		return this.plugin.app;
	}

	onload(): void {
		const ws = this.app.workspace;
		this.registerEvent(ws.on("active-leaf-change", () => this.refresh()));
		this.registerEvent(ws.on("layout-change", () => this.refresh()));
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (chordOfCanvas(file.path) !== null) this.refresh();
			}),
		);
		// A stub's chord or after changed: the canvas may differ now, or agree again.
		this.registerEvent(this.app.metadataCache.on("changed", () => this.refresh()));
		ws.onLayoutReady(() => this.refresh());
	}

	onunload(): void {
		document.querySelectorAll(`.${BAR}`).forEach((el) => el.remove());
	}

	private views(): FileView[] {
		return this.app.workspace
			.getLeavesOfType("canvas")
			.map((leaf) => leaf.view)
			.filter((v): v is FileView => v instanceof FileView && v.file !== null && chordOfCanvas(v.file.path) !== null);
	}

	private async update(): Promise<void> {
		const views = this.views();
		const open = new Set(views.map((v) => v.file?.path ?? ""));
		document.querySelectorAll<HTMLElement>(`.${BAR}`).forEach((el) => {
			if (!open.has(el.dataset.path ?? "")) el.remove();
		});
		for (const view of views) {
			const path = view.file?.path ?? "";
			const chord = chordOfCanvas(path);
			if (chord === null) continue;
			let state: CanvasState | null = null;
			try {
				state = (await this.plugin.atlas<{ canvas: CanvasState }>(["chord", "canvas", chord])).canvas;
			} catch {
				// No chord of that title: the canvas is the user's own.
			}
			this.states.set(path, state);
			this.render(view, chord, state);
		}
	}

	private render(view: FileView, chord: string, state: CanvasState | null): void {
		const path = view.file?.path ?? "";
		const existing = view.containerEl.querySelector<HTMLElement>(`:scope > .${BAR}`);
		if (!state) {
			existing?.remove();
			return;
		}
		const key = `${path}\n${state.differs}\n${(state.changes ?? []).join("|")}`;
		if (existing?.dataset.key === key) return;
		existing?.remove();
		const bar = createDiv({ cls: BAR });
		bar.dataset.key = key;
		bar.dataset.path = path;
		bar.toggleClass("is-changed", state.differs);
		bar.createSpan({ cls: "atlas-canvas-bar-label", text: "Chord" });
		const text = bar.createSpan({ cls: "atlas-canvas-bar-status", text: canvasSummary(state) });
		if (state.differs) text.setAttr("title", (state.threads ?? []).join("\n"));
		const buttons = bar.createDiv({ cls: "atlas-canvas-bar-buttons" });
		const add = (label: string, cls: string, args: string[], done: string) => {
			const b = buttons.createEl("button", { text: label, cls });
			b.onclick = () => void this.run(["chord", "canvas", chord, ...args], done);
		};
		if (state.differs) {
			add("Save order", "mod-cta", ["--save"], "Saved the order to the stubs");
			add("Revert", "", ["--write"], "Took the stubs' order back");
		}
		add("Tidy", "", ["--tidy"], "Placed the cards again");
		buttons.createEl("button", { text: "New thread" }).onclick = () => {
			const note = this.app.metadataCache.getFirstLinkpathDest(chord, "");
			const id = note ? this.app.metadataCache.getFileCache(note)?.frontmatter?.id : undefined;
			if (id) this.plugin.newThread({ id: String(id), title: chord });
		};
		buttons.createEl("button", { text: "Open the chord" }).onclick = () => void this.app.workspace.openLinkText(chord, "", "tab");
		view.containerEl.insertBefore(bar, view.contentEl);
	}

	private async run(args: string[], done: string): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			// The canvas view writes its state to the file a moment after an edit.
			await new Promise((resolve) => window.setTimeout(resolve, 600));
			await this.plugin.atlas<unknown>(args);
			new Notice(`Atlas: ${done}.`);
		} catch (e) {
			new Notice(`Atlas: ${(e as Error).message}`, 10_000);
		} finally {
			this.busy = false;
			this.refresh();
		}
	}
}
