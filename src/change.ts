import { App, MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownView, Modal, Notice, Setting } from "obsidian";
import { ChangeAction, changeCard, rejectReason } from "./changestate";
import { countsLine, lastProgressLine } from "./helpers";
import type AtlasPlugin from "./main";

interface Preview {
	ref?: { title?: string };
	counts?: unknown;
	warnings?: string[] | null;
	commit?: string;
}

/**
 * Runs Approve and Cancel for every change widget, one command at a time, and tells the
 * widgets when a command starts or ends.
 */
export class ChangeRunner {
	private current: { id: string; action: ChangeAction } | null = null;
	private listeners = new Set<() => void>();

	constructor(private plugin: AtlasPlugin) {}

	/** The command that runs for this change, if one does. */
	actionFor(id: string): ChangeAction | null {
		return this.current?.id === id ? this.current.action : null;
	}

	get busy(): boolean {
		return this.current !== null;
	}

	/** Calls fn when a command starts or ends; returns the call that stops it. */
	listen(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	async apply(id: string, sourcePath: string): Promise<void> {
		await this.run(id, "apply", sourcePath, async () => {
			// An edit typed a moment ago goes into the change.
			await saveOpen(this.plugin.app, sourcePath);
			const p = await this.plugin.atlas<Preview>(["change", "apply", id]);
			const counts = countsLine(p.counts);
			const commit = p.commit ? ` Commit ${p.commit.slice(0, 7)}.` : "";
			new Notice(`Atlas: applied ${p.ref?.title ?? id}${counts ? `: ${counts}` : ""}.${commit}`);
			warn(p.warnings);
		});
	}

	async reject(id: string, reason: string, sourcePath: string): Promise<void> {
		await this.run(id, "reject", sourcePath, async () => {
			const p = await this.plugin.atlas<Preview>(["change", "reject", id, "--reason", rejectReason(reason)]);
			new Notice(`Atlas: rejected ${p.ref?.title ?? id}.`);
			warn(p.warnings);
		});
	}

	/**
	 * Runs one command. The widget stays busy until Obsidian reads the document's new
	 * status, so it never offers Approve again for a change that was just applied.
	 */
	private async run(id: string, action: ChangeAction, sourcePath: string, fn: () => Promise<void>): Promise<void> {
		if (this.current) {
			new Notice("Atlas: a change command runs. Wait for it to finish.");
			return;
		}
		this.current = { id, action };
		this.emit();
		const decided = decision(this.plugin.app, sourcePath, SETTLE_MS);
		try {
			await fn();
			await decided.done;
		} catch (e) {
			new Notice(`Atlas: ${(e as Error).message}`, 10_000);
		} finally {
			decided.stop();
			this.current = null;
			this.emit();
		}
	}

	private emit(): void {
		for (const fn of this.listeners) fn();
	}
}

const SETTLE_MS = 5000;

/** Resolves when the metadata cache reads a decided status for the note (not proposed,
 * applying, or running), or after ms. */
function decision(app: App, path: string, ms: number): { done: Promise<void>; stop: () => void } {
	let stop = () => {};
	const done = new Promise<void>((resolve) => {
		const ref = app.metadataCache.on("changed", (file, _data, cache) => {
			const status = cache.frontmatter?.status;
			if (file.path === path && !["proposed", "applying", "running"].includes(status)) finish();
		});
		const timer = window.setTimeout(() => finish(), ms);
		function finish(): void {
			app.metadataCache.offref(ref);
			window.clearTimeout(timer);
			resolve();
		}
		stop = finish;
	});
	return { done, stop };
}

/** Saves the open views of a note, so a click acts on what the user sees. */
export async function saveOpen(app: App, path: string): Promise<void> {
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view;
		if (view instanceof MarkdownView && view.file?.path === path) await view.save();
	}
}

function warn(warnings: string[] | null | undefined): void {
	for (const w of warnings ?? []) new Notice(`Atlas: ${w}`, 10_000);
}

/**
 * The atlas-change block: a card drawn from the frontmatter of the note that holds it. Its
 * class is atlas-change-card: atlas-change is the cssclass of the change document itself.
 */
class ChangeWidget extends MarkdownRenderChild {
	private generation = 0;

	constructor(
		containerEl: HTMLElement,
		private plugin: AtlasPlugin,
		private runner: ChangeRunner,
		private path: string,
	) {
		super(containerEl);
	}

	onload(): void {
		const { metadataCache, vault } = this.plugin.app;
		this.registerEvent(
			metadataCache.on("changed", (file) => {
				if (file.path === this.path) void this.render();
			}),
		);
		this.registerEvent(
			vault.on("rename", (file, oldPath) => {
				if (oldPath === this.path) this.path = file.path;
			}),
		);
		this.register(this.runner.listen(() => void this.render()));
		void this.render();
	}

	private frontmatter(): Record<string, unknown> | undefined {
		const file = this.plugin.app.vault.getFileByPath(this.path);
		return file ? this.plugin.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
	}

	/** The last line of a running change's Progress section, read from the file: the cache holds no body text. */
	private async progress(fm: Record<string, unknown> | undefined): Promise<string> {
		const file = fm?.status === "running" ? this.plugin.app.vault.getFileByPath(this.path) : null;
		return file ? lastProgressLine(await this.plugin.app.vault.read(file)) : "";
	}

	private async render(): Promise<void> {
		const generation = ++this.generation;
		const fm = this.frontmatter();
		const progress = await this.progress(fm).catch(() => "");
		if (generation !== this.generation) return;
		const card = changeCard(fm, this.runner.actionFor(typeof fm?.id === "string" ? fm.id : ""), progress);
		const el = this.containerEl;
		el.empty();
		el.addClass("atlas-change-card");
		el.dataset.state = card.state;

		const head = el.createDiv({ cls: "atlas-change-head" });
		head.createSpan({ cls: "atlas-change-label", text: card.label });
		if (card.kind) head.createSpan({ cls: "atlas-change-kind", text: card.kind });
		if (card.counts) head.createSpan({ cls: "atlas-change-counts", text: card.counts });
		el.createDiv({ cls: "atlas-change-line", text: card.line });
		if (card.buttons.length === 0) return;

		const buttons = el.createDiv({ cls: "atlas-change-buttons" });
		const running = card.state === "running";
		for (const b of card.buttons) {
			const button = buttons.createEl("button", { cls: b === "approve" ? "mod-cta" : "", text: b === "approve" ? "Approve" : "Cancel" });
			if (this.runner.busy) {
				button.disabled = true;
				button.setAttr("title", "Another change command runs.");
			}
			button.onclick =
				b === "approve"
					? () => void this.runner.apply(card.id, this.path)
					: () => new CancelModal(this.plugin.app, running, (reason) => void this.runner.reject(card.id, reason, this.path)).open();
		}
	}
}

/** Renders every atlas-change code block, in reading view and in live preview. */
export function changeProcessor(plugin: AtlasPlugin, runner: ChangeRunner) {
	return (_source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		ctx.addChild(new ChangeWidget(el, plugin, runner, ctx.sourcePath));
	};
}

/** Asks for the optional reason before Cancel rejects the change. */
class CancelModal extends Modal {
	private reason = "";

	constructor(
		app: App,
		private running: boolean,
		private done: (reason: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Cancel this change");
		this.contentEl.createEl("p", {
			text: this.running
				? "Atlas rejects the work. The agent stops when it reports its next step, and this document stays as the record."
				: "Atlas rejects the change. Nothing it would write changes, and its document stays as the record.",
		});
		const submit = () => {
			this.close();
			this.done(this.reason);
		};
		new Setting(this.contentEl)
			.setName("Reason")
			.setDesc("Optional. One line.")
			.addText((text) => {
				text.setPlaceholder("Why not").onChange((v) => (this.reason = v));
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
			.addButton((b) => b.setButtonText("Back").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Cancel the change").setWarning().onClick(submit));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
