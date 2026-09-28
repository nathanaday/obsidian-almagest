import { App, Component, MarkdownView, Modal, Notice, Setting, debounce } from "obsidian";
import { countsLine } from "./helpers";
import type AtlasPlugin from "./main";

const BAR = "atlas-change-bar";

interface Preview {
	ref?: { title?: string };
	status?: string;
	counts?: unknown;
	warnings?: string[] | null;
	commit?: string;
}

/** The change a view shows, when it is a proposed one. */
function proposed(app: App, view: MarkdownView): { id: string; counts: string } | null {
	if (!view.file) return null;
	const fm = app.metadataCache.getFileCache(view.file)?.frontmatter;
	if (!fm || fm.type !== "change" || fm.status !== "proposed" || !fm.id) return null;
	return { id: String(fm.id), counts: countsLine(fm.counts) };
}

/** The Apply and Reject bar over a proposed change. */
export class ChangeBar extends Component {
	private busy = false;
	readonly refresh = debounce(() => this.update(), 100, true);

	constructor(private plugin: AtlasPlugin) {
		super();
	}

	private get app(): App {
		return this.plugin.app;
	}

	onload(): void {
		const ws = this.app.workspace;
		this.registerEvent(ws.on("active-leaf-change", () => this.refresh()));
		this.registerEvent(ws.on("file-open", () => this.refresh()));
		this.registerEvent(ws.on("layout-change", () => this.refresh()));
		this.registerEvent(this.app.metadataCache.on("changed", () => this.refresh()));
		ws.onLayoutReady(() => this.refresh());
	}

	onunload(): void {
		document.querySelectorAll(`.${BAR}`).forEach((el) => el.remove());
	}

	private update(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView) this.updateView(leaf.view);
		}
	}

	private updateView(view: MarkdownView): void {
		const change = proposed(this.app, view);
		const existing = view.containerEl.querySelector<HTMLElement>(`:scope > .${BAR}`);
		if (!change) {
			existing?.remove();
			return;
		}
		const key = `${change.id}\n${change.counts}`;
		if (existing?.dataset.key === key) return;
		existing?.remove();

		const bar = createDiv({ cls: BAR });
		bar.dataset.key = key;
		bar.createSpan({ cls: "atlas-change-bar-label", text: "Proposed change" });
		if (change.counts) bar.createSpan({ cls: "atlas-change-bar-counts", text: change.counts });
		const buttons = bar.createDiv({ cls: "atlas-change-bar-buttons" });
		const apply = buttons.createEl("button", { cls: "mod-cta", text: "Apply" });
		const reject = buttons.createEl("button", { cls: "mod-warning", text: "Reject" });
		apply.onclick = () => void this.apply(view, change.id, [apply, reject]);
		reject.onclick = () =>
			new ReasonModal(this.app, (reason) => void this.reject(change.id, reason, [apply, reject])).open();
		view.containerEl.insertBefore(bar, view.contentEl);
	}

	private async run(buttons: HTMLButtonElement[], action: () => Promise<void>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		buttons.forEach((b) => (b.disabled = true));
		try {
			await action();
		} catch (e) {
			new Notice(`Atlas: ${(e as Error).message}`);
		} finally {
			this.busy = false;
			buttons.forEach((b) => (b.disabled = false));
			this.refresh();
		}
	}

	private apply(view: MarkdownView, id: string, buttons: HTMLButtonElement[]): Promise<void> {
		return this.run(buttons, async () => {
			// An edit typed a moment ago goes into the change.
			await view.save();
			const p = await this.plugin.atlas<Preview>(["change", "apply", id]);
			const counts = countsLine(p.counts);
			const commit = p.commit ? ` Commit ${p.commit.slice(0, 7)}.` : "";
			new Notice(`Applied ${p.ref?.title ?? id}${counts ? `: ${counts}` : ""}.${commit}`);
			warn(p.warnings);
		});
	}

	private reject(id: string, reason: string, buttons: HTMLButtonElement[]): Promise<void> {
		return this.run(buttons, async () => {
			const p = await this.plugin.atlas<Preview>(["change", "reject", id, "--reason", reason]);
			new Notice(`Rejected ${p.ref?.title ?? id}.`);
			warn(p.warnings);
		});
	}
}

function warn(warnings: string[] | null | undefined): void {
	for (const w of warnings ?? []) new Notice(`Atlas: ${w}`);
}

/** Asks for the one-line reason of a rejection. */
class ReasonModal extends Modal {
	private reason = "";

	constructor(app: App, private done: (reason: string) => void) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Reject the change");
		const submit = () => {
			this.close();
			this.done(this.reason);
		};
		new Setting(this.contentEl).setName("Reason").addText((text) => {
			text.setPlaceholder("One line").onChange((v) => (this.reason = v));
			text.inputEl.addClass("atlas-reason-input");
			text.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					submit();
				}
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Reject").setWarning().onClick(submit));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
