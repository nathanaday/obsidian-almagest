import { App, Component, MarkdownView, Modal, Notice, Setting, debounce } from "obsidian";
import { BarDoc, barButtons, barStatus, handoffLine } from "./helpers";
import type AtlasPlugin from "./main";

const BAR = "atlas-thread-bar";

/** The stub or chord a view shows, or null. */
function barDoc(app: App, view: MarkdownView): BarDoc | null {
	if (!view.file) return null;
	const fm = app.metadataCache.getFileCache(view.file)?.frontmatter;
	if (!fm || !fm.id || (fm.type !== "stub" && fm.type !== "chord")) return null;
	return {
		id: String(fm.id),
		type: fm.type,
		title: view.file.basename,
		status: String(fm.status ?? (fm.type === "stub" ? "stub" : "open")),
		blocked: Boolean(fm.blocked),
		tasks: String(fm.tasks ?? ""),
		threads: String(fm.threads ?? ""),
	};
}

/** Folds the properties block of a view. The editor of properties is not public API. */
function foldProperties(view: MarkdownView): void {
	const editor = (view as unknown as { metadataEditor?: { setCollapse?(collapsed: boolean, animate: boolean): void } }).metadataEditor;
	try {
		editor?.setCollapse?.(true, false);
	} catch {
		// No fold, no harm.
	}
}

/**
 * The bar over a stub or a chord: its status, the hand-off line to copy, and the moves
 * that are the user's to make without an agent: block, unblock, drop, and reopen. Each
 * runs the thread or chord command, which records the event as the user's. Nothing here
 * closes a thread: code closes it when it is verified and its wiki change is applied.
 */
export class ThreadBar extends Component {
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

	/** Copies the hand-off line of the stub or chord in the active view. */
	copyActive(): boolean {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const d = view ? barDoc(this.app, view) : null;
		if (!d) return false;
		void this.copy(d);
		return true;
	}

	private async copy(d: BarDoc): Promise<void> {
		const line = handoffLine(d.type, d.id);
		try {
			await navigator.clipboard.writeText(line);
			new Notice(`Atlas: copied "${line}". Paste it into an agent session.`);
		} catch {
			new Notice(`Atlas: ${line}`);
		}
	}

	private update(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView) this.updateView(leaf.view);
		}
	}

	private updateView(view: MarkdownView): void {
		const d = barDoc(this.app, view);
		const existing = view.containerEl.querySelector<HTMLElement>(`:scope > .${BAR}`);
		if (!d) {
			existing?.remove();
			return;
		}
		const key = [d.id, d.status, d.blocked, d.tasks, d.threads, d.title].join("\n");
		if (existing?.dataset.key === key) return;
		// A stub is a front page: its properties open folded, once per opening of the file.
		if (existing?.dataset.id !== d.id) foldProperties(view);
		existing?.remove();
		const bar = createDiv({ cls: BAR });
		bar.dataset.key = key;
		bar.dataset.id = d.id;
		bar.dataset.status = d.blocked ? "blocked" : d.status;
		bar.createSpan({ cls: "atlas-thread-bar-label", text: d.type === "stub" ? "Thread" : "Chord" });
		bar.createSpan({ cls: "atlas-thread-bar-status", text: barStatus(d) });
		const buttons = bar.createDiv({ cls: "atlas-thread-bar-buttons" });
		const tool = d.type === "stub" ? "thread" : "chord";
		const noun = d.type === "stub" ? "thread" : "chord";
		for (const b of barButtons(d)) {
			const el = buttons.createEl("button", { text: b.label });
			if (b.id === "handoff") el.addClass("mod-cta");
			el.onclick = () => {
				switch (b.id) {
					case "handoff":
						return void this.copy(d);
					case "canvas":
						return void this.app.workspace.openLinkText(`chords/${d.title}.canvas`, "", false);
					case "unblock":
						return void this.run([tool, "unblock", d.id], "Unblocked");
					case "block":
						return new ReasonModal(this.app, `Block the ${noun}`, "What it waits on, in one line", true, (r) => void this.run([tool, "block", d.id, "--reason", r], "Blocked")).open();
					case "drop":
						return new ReasonModal(this.app, `Drop the ${noun}`, "Why", true, (r) => void this.run([tool, "drop", d.id, "--reason", r], "Dropped")).open();
					case "reopen":
						return new ReasonModal(this.app, `Reopen the ${noun}`, "Why (optional)", false, (r) => void this.run([tool, "reopen", d.id, "--reason", r], "Reopened")).open();
				}
			};
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
