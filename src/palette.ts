import { App, ItemView, Modal, Notice, WorkspaceLeaf, debounce } from "obsidian";
import { saveOpen } from "./change";
import { isSnapshotPath, lastProgressLine } from "./helpers";
import { JOURNALS, JournalVolume, publishBlocked } from "./journalstate";
import type AtlasPlugin from "./main";
import { ingestMessage, repairMessage, resolveMessage } from "./messages";
import {
	LintResult,
	LintSummary,
	PaletteState,
	Ref,
	TrashOutcome,
	TrashResult,
	VaultStatus,
	lintSummary,
	paletteState,
	plural,
	trashOutcome,
} from "./palettestate";
import { confirmPublish } from "./publish";
import { sessionGroups } from "./sessions";

export const PALETTE_VIEW = "atlas-palette";
export const PALETTE_ICON = "map";

const REFRESH_MS = 30_000;
const EVENT_DELAY = 1500;

/** What change start prints: the work document. */
interface Started {
	ref: { id: string; title: string; path: string };
}

type Action = "ingest" | "lint" | "repair" | "trash";

/**
 * The Atlas palette: the vault's status from one `vault --json` call, the agents it started,
 * and the actions. It refreshes after vault events and every 30 seconds while it is open.
 */
export class PaletteView extends ItemView {
	private state: PaletteState | null = null;
	private error = "";
	/** The last progress line of each running work document, by path. */
	private progress = new Map<string, string>();
	private lint: LintSummary | null = null;
	private busy: Action | null = null;
	private loading = false;
	private again = false;
	private readonly soon = debounce(() => void this.refresh(), EVENT_DELAY, true);

	constructor(leaf: WorkspaceLeaf, private plugin: AtlasPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return PALETTE_VIEW;
	}

	getDisplayText(): string {
		return "Atlas";
	}

	getIcon(): string {
		return PALETTE_ICON;
	}

	async onOpen(): Promise<void> {
		const touch = (...paths: string[]) => {
			if (paths.some((p) => isSnapshotPath(p, this.app.vault.configDir))) this.soon();
		};
		this.registerEvent(this.app.vault.on("create", (f) => touch(f.path)));
		this.registerEvent(this.app.vault.on("modify", (f) => touch(f.path)));
		this.registerEvent(this.app.vault.on("delete", (f) => touch(f.path)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => touch(f.path, old)));
		this.registerEvent(this.app.workspace.on("file-open", () => this.render()));
		this.registerInterval(window.setInterval(() => void this.refresh(), REFRESH_MS));
		this.render();
		void this.refresh();
	}

	async onClose(): Promise<void> {
		this.soon.cancel();
	}

	/** Reads the status again. One read runs at a time; a call during a read runs one more after it. */
	async refresh(): Promise<void> {
		if (this.loading) {
			this.again = true;
			return;
		}
		this.loading = true;
		try {
			do {
				this.again = false;
				await this.readStatus();
			} while (this.again);
		} finally {
			this.loading = false;
		}
		this.render();
	}

	private async readStatus(): Promise<void> {
		try {
			const out = await this.plugin.atlas<{ status: VaultStatus }>(["vault"]);
			const { groups } = await sessionGroups(this.app, this.plugin.staleHours());
			const state = paletteState(out.status, groups.open.length);
			const progress = new Map<string, string>();
			for (const r of state.running) {
				const file = this.app.vault.getFileByPath(r.path);
				if (file) progress.set(r.path, lastProgressLine(await this.app.vault.read(file)));
			}
			this.state = state;
			this.progress = progress;
			this.error = "";
		} catch (e) {
			this.error = (e as Error).message;
		}
		this.plugin.checkConversations();
	}

	render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("atlas-palette");
		this.renderStatus(root);
		this.renderRunning(root);
		this.renderJournals(root);
		this.renderActions(root);
	}

	private section(root: HTMLElement, name: string): HTMLElement {
		const el = root.createDiv({ cls: "atlas-palette-section" });
		el.createDiv({ cls: "atlas-palette-heading", text: name });
		return el;
	}

	private row(parent: HTMLElement, key: string, name: string, value: string): HTMLElement {
		const row = parent.createDiv({ cls: "atlas-palette-row" });
		row.dataset.row = key;
		row.createSpan({ cls: "atlas-palette-name", text: name });
		row.createSpan({ cls: "atlas-palette-value", text: value });
		return row;
	}

	private link(parent: HTMLElement, title: string, path: string): HTMLElement {
		const a = parent.createEl("a", { cls: "atlas-palette-link", text: title, href: "#" });
		a.setAttr("title", path);
		a.onclick = (evt) => {
			evt.preventDefault();
			void this.openPath(path, evt.metaKey || evt.ctrlKey);
		};
		return a;
	}

	private renderStatus(root: HTMLElement): void {
		const el = this.section(root, "Status");
		if (this.error) el.createDiv({ cls: "atlas-palette-error", text: `Atlas: ${this.error}` });
		const s = this.state;
		if (!s) {
			if (!this.error) el.createDiv({ cls: "atlas-palette-quiet", text: "Reading the vault…" });
			return;
		}
		const list = (refs: Ref[], line?: (r: Ref) => string) => {
			if (refs.length === 0) return;
			const ul = el.createEl("ul", { cls: "atlas-palette-list" });
			for (const r of refs) {
				const li = ul.createEl("li");
				this.link(li, r.title, r.path);
				const extra = line?.(r);
				if (extra) li.createDiv({ cls: "atlas-palette-progress", text: extra });
			}
		};
		this.row(el, "proposed", "Proposed changes", String(s.proposed.length));
		list(s.proposed);
		this.row(el, "running", "Running work", String(s.running.length));
		list(s.running, (r) => [r.kind, this.progress.get(r.path) || "no step yet"].filter((x) => x).join(" · "));
		this.row(el, "ingest", "Ingest", plural(s.ingest.length, "file", "files"));
		if (s.ingest.length > 0) {
			const ul = el.createEl("ul", { cls: "atlas-palette-list atlas-palette-files" });
			for (const name of s.ingest) ul.createEl("li", { text: name });
		}
		this.row(el, "pending", "Pending sources", String(s.pending));
		const sessions = this.row(el, "sessions", "Live sessions", String(s.sessions));
		const open = sessions.createEl("button", { cls: "atlas-palette-small", text: "Open sessions" });
		open.onclick = () => void this.plugin.openSessions();
		this.row(el, "trash", "Trash", plural(s.trash, "file", "files"));
		this.row(el, "journals", "Journals", `${s.toPublish} to publish`);
		this.row(el, "problems", "Lint problems", plural(s.problems, "error", "errors"));
	}

	private renderRunning(root: HTMLElement): void {
		const running = this.plugin.conversations.list();
		if (running.length === 0) return;
		const el = this.section(root, "Running");
		const ul = el.createEl("ul", { cls: "atlas-palette-list" });
		for (const c of running) {
			const li = ul.createEl("li", { cls: "atlas-palette-agent" });
			li.createSpan({ cls: "atlas-palette-badge", text: c.label });
			this.link(li, c.path.slice(c.path.lastIndexOf("/") + 1).replace(/\.md$/, ""), c.path);
		}
	}

	private renderJournals(root: HTMLElement): void {
		const s = this.state;
		if (!s) return;
		const el = this.section(root, "Journals");
		if (s.journals.length === 0) {
			el.createDiv({ cls: "atlas-palette-quiet", text: `No journal yet: a volume is a folder directly under ${JOURNALS}/.` });
			return;
		}
		for (const vol of s.journals) this.renderVolume(el, vol);
	}

	private renderVolume(parent: HTMLElement, vol: JournalVolume): void {
		const el = parent.createDiv({ cls: "atlas-palette-volume" });
		el.dataset.volume = vol.volume;
		el.dataset.changed = String(vol.changed);
		const head = el.createDiv({ cls: "atlas-palette-row" });
		head.createSpan({ cls: "atlas-palette-name atlas-palette-volume-name", text: vol.name }).setAttr("title", `${JOURNALS}/${vol.volume}/`);
		if (vol.changed) head.createSpan({ cls: "atlas-palette-badge atlas-palette-changed", text: "changed" });
		head.createSpan({ cls: "atlas-palette-value", text: plural(vol.notes, "note", "notes") });

		const edition = el.createDiv({ cls: "atlas-palette-progress atlas-palette-edition" });
		if (vol.edition) {
			const file = this.app.metadataCache.getFirstLinkpathDest(vol.edition, "");
			if (file) this.link(edition, vol.edition, file.path);
			else edition.setText(vol.edition);
		} else {
			edition.setText("never published");
		}

		const why = publishBlocked(vol);
		const publishing = this.plugin.publishing === vol.volume;
		const button = el.createEl("button", { cls: "atlas-palette-small atlas-palette-publish", text: publishing ? "Publish…" : "Publish" });
		if (why || this.busy || this.plugin.publishing) {
			button.disabled = true;
			button.setAttr("title", why || "Another action runs.");
		} else {
			button.addClass("mod-cta");
		}
		button.onclick = () => confirmPublish(this.plugin, vol);
	}

	private renderActions(root: HTMLElement): void {
		const el = this.section(root, "Actions");
		const files = this.state?.ingest.length ?? 0;
		this.action(el, "ingest", files > 0 ? `Ingest ${plural(files, "file", "files")}` : "Ingest", files > 0 ? "" : "ingest/ holds no file.", () => this.ingest());

		this.action(el, "lint", "Wiki lint", "", () => this.runLint());
		if (this.lint) this.renderLint(el, this.lint);

		const file = this.app.workspace.getActiveFile();
		this.action(el, "trash", "Safe delete this file", file ? "" : "Open a file first.", () => this.safeDelete(), file?.path ?? "");
	}

	/** A button of an action. why disables it; a running action disables every one. */
	private action(parent: HTMLElement, name: Action, text: string, why: string, run: () => Promise<void>, note = ""): void {
		const wrap = parent.createDiv({ cls: "atlas-palette-action" });
		wrap.dataset.action = name;
		const button = wrap.createEl("button", { text: this.busy === name ? `${text}…` : text });
		if (why || this.busy || this.plugin.publishing) {
			button.disabled = true;
			button.setAttr("title", why || "Another action runs.");
		}
		button.onclick = () => void this.act(name, run);
		if (why) wrap.createDiv({ cls: "atlas-palette-quiet", text: why });
		else if (note) wrap.createDiv({ cls: "atlas-palette-quiet atlas-palette-path", text: note });
	}

	private async act(name: Action, run: () => Promise<void>): Promise<void> {
		if (this.busy || this.plugin.publishing) return;
		this.busy = name;
		this.render();
		try {
			await run();
		} catch (e) {
			new Notice(`Atlas: ${(e as Error).message}`, 10_000);
		} finally {
			this.busy = null;
			this.render();
			void this.refresh();
		}
	}

	private renderLint(parent: HTMLElement, lint: LintSummary): void {
		const el = parent.createDiv({ cls: "atlas-palette-lint" });
		el.createDiv({ cls: "atlas-palette-lint-counts", text: lint.counts });
		if (lint.first.length > 0) {
			const ul = el.createEl("ul", { cls: "atlas-palette-list" });
			for (const f of lint.first) {
				const li = ul.createEl("li", { cls: "atlas-palette-finding" });
				li.dataset.severity = f.severity;
				li.createSpan({ cls: "atlas-palette-badge", text: f.check });
				this.link(li, f.doc.title || f.doc.path, f.doc.path);
				li.createDiv({ cls: "atlas-palette-progress", text: f.message });
			}
		}
		if (lint.more > 0) el.createDiv({ cls: "atlas-palette-quiet", text: `${lint.more} more: run wiki-review for all of them.` });
		if (lint.repairable > 0) {
			this.action(el, "repair", "Repair with an agent", "", () => this.repair(), `${plural(lint.repairable, "finding", "findings")} that a change repairs`);
		}
	}

	// Actions

	private async ingest(): Promise<void> {
		const files = this.state?.ingest ?? [];
		if (files.length === 0) return;
		const doc = await this.start(["change", "start", "--kind", "ingest", ...files.map((f) => `--file=${f}`)]);
		await this.plugin.runAgent(ingestMessage(doc), `Agent · ${doc.title}`, "ingest");
	}

	private async runLint(): Promise<void> {
		this.lint = lintSummary(await this.plugin.atlas<LintResult>(["lint"]));
	}

	private async repair(): Promise<void> {
		const doc = await this.start(["change", "start", "--kind", "repair", "--title", "Repair the lint findings"]);
		await this.plugin.runAgent(repairMessage(doc), `Agent · ${doc.title}`, "repair");
	}

	private async safeDelete(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;
		// An edit typed a moment ago goes to trash with the file.
		await saveOpen(this.app, file.path);
		// A path that begins with a dash would read as an option.
		const arg = file.path.startsWith("-") ? `./${file.path}` : file.path;
		const out = await this.plugin.atlas<{ trash: TrashResult }>(["vault", "trash", arg], [2]);
		const outcome = trashOutcome(out.trash);
		if (outcome.kind === "linked") {
			new BacklinksModal(this.app, outcome, (path) => void this.openPath(path, false), () =>
				void this.act("trash", () => this.plugin.runAgent(resolveMessage(outcome, outcome.backlinks), `Agent · Remove ${outcome.title}`, "remove")),
			).open();
			return;
		}
		new Notice(`Atlas: ${outcome.line}`, outcome.kind === "error" ? 10_000 : 6000);
	}

	/** Starts a work document and opens it. */
	private async start(args: string[]): Promise<{ id: string; title: string; path: string }> {
		const { ref } = await this.plugin.atlas<Started>(args);
		await this.openPath(ref.path, true);
		return ref;
	}

	private openPath(path: string, newTab: boolean): Promise<void> {
		return this.plugin.openWhenSeen(path, newTab);
	}
}

/** The documents that keep a file from safe delete, and the agent that resolves them. */
class BacklinksModal extends Modal {
	constructor(
		app: App,
		private outcome: Extract<TrashOutcome, { kind: "linked" }>,
		private show: (path: string) => void,
		private resolve: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { outcome } = this;
		this.setTitle(`${outcome.title} stays`);
		const el = this.contentEl;
		el.addClass("atlas-backlinks");
		el.createEl("p", {
			text: `${plural(outcome.backlinks.length, "document links", "documents link")} ${outcome.path}, so safe delete moved nothing. Point each link elsewhere, or drop it; then the file can go to trash/.`,
		});
		const ul = el.createEl("ul");
		for (const b of outcome.backlinks) {
			const li = ul.createEl("li");
			const a = li.createEl("a", { text: b.title || b.path, href: "#" });
			a.setAttr("title", b.path);
			a.onclick = (evt) => {
				evt.preventDefault();
				this.close();
				this.show(b.path);
			};
			if (b.type) li.createSpan({ cls: "atlas-backlinks-type", text: ` ${b.kind || b.type}` });
		}
		const buttons = el.createDiv({ cls: "atlas-backlinks-buttons" });
		buttons.createEl("button", { text: "Close" }).onclick = () => this.close();
		const go = buttons.createEl("button", { cls: "mod-cta", text: "Resolve with an agent" });
		go.onclick = () => {
			this.close();
			this.resolve();
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
