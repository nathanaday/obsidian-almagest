import { App, Component, MarkdownView, Modal, Notice, Setting, debounce } from "obsidian";
import type AtlasPlugin from "./main";

const BAR = "atlas-work-bar";

interface Doc {
	id: string;
	kind: string;
	status: string;
	blocked: boolean;
}

/** The stub or plan a view shows, or null. */
function workDoc(app: App, view: MarkdownView): Doc | null {
	if (!view.file) return null;
	const fm = app.metadataCache.getFileCache(view.file)?.frontmatter;
	if (!fm || !fm.id) return null;
	if (fm.type === "stub") return { id: String(fm.id), kind: "stub", status: String(fm.status ?? "open"), blocked: false };
	if (fm.type === "spec" && fm.kind === "plan") {
		return { id: String(fm.id), kind: "plan", status: String(fm.status ?? "open"), blocked: Boolean(fm.blocked) };
	}
	return null;
}

const closed = (s: string) => s === "done" || s === "dropped" || s === "resolved";

/**
 * The moves on a stub or a plan that are the user's to make without an agent: drop,
 * reopen, block, and unblock. Each runs the work command, which records the event as the
 * user's. Starting and finishing work stay with agents, since done needs the result.
 */
export class WorkBar extends Component {
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
		const d = workDoc(this.app, view);
		const existing = view.containerEl.querySelector<HTMLElement>(`:scope > .${BAR}`);
		if (!d) {
			existing?.remove();
			return;
		}
		const key = `${d.id}\n${d.status}\n${d.blocked}`;
		if (existing?.dataset.key === key) return;
		existing?.remove();
		const bar = createDiv({ cls: BAR });
		bar.dataset.key = key;
		bar.createSpan({ cls: "atlas-work-bar-label", text: d.kind === "stub" ? "Stub" : "Plan" });
		bar.createSpan({ cls: "atlas-work-bar-status", text: d.blocked ? `${d.status}, blocked` : d.status });
		const buttons = bar.createDiv({ cls: "atlas-work-bar-buttons" });
		const add = (text: string, run: () => void) => {
			const b = buttons.createEl("button", { text });
			b.onclick = run;
		};
		if (closed(d.status)) {
			add("Reopen", () => new ReasonModal(this.app, "Reopen", "Why (optional)", false, (r) => void this.run(["work", "reopen", d.id, "--reason", r], "Reopened")).open());
		} else {
			if (d.kind === "plan") {
				if (d.blocked) add("Unblock", () => void this.run(["work", "unblock", d.id], "Unblocked"));
				else add("Block", () => new ReasonModal(this.app, "Block the plan", "What it waits on, in one line", true, (r) => void this.run(["work", "block", d.id, "--reason", r], "Blocked")).open());
			}
			add("Drop", () => new ReasonModal(this.app, "Drop", "Why", true, (r) => void this.run(["work", "drop", d.id, "--reason", r], "Dropped")).open());
		}
		view.containerEl.insertBefore(bar, view.contentEl);
	}

	private async run(args: string[], done: string): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			await this.plugin.atlas<unknown>(args);
			new Notice(`Atlas: ${done}.`);
		} catch (e) {
			new Notice(`Atlas: ${(e as Error).message}`);
		} finally {
			this.busy = false;
			this.refresh();
		}
	}
}

/** Asks for one line. */
export class ReasonModal extends Modal {
	private reason = "";

	constructor(app: App, private heading: string, private placeholder: string, private required: boolean, private done: (reason: string) => void) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.heading);
		const submit = () => {
			if (this.required && this.reason.trim() === "") return;
			this.close();
			this.done(this.reason.trim());
		};
		new Setting(this.contentEl).setName("Reason").addText((text) => {
			text.setPlaceholder(this.placeholder).onChange((v) => (this.reason = v));
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
			.addButton((b) => b.setButtonText(this.heading).setCta().onClick(submit));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
