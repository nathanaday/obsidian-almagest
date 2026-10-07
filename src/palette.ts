import { App, ItemView, Modal, Notice, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import { saveOpen } from "./change";
import { CheckoutModal, returnCheckout, startCheckout } from "./checkout";
import { Checkout, LEDGER, indexPath } from "./checkoutstate";
import { SessionGroups, SessionState, plainLinks } from "./agents";
import { INGEST, RETURNED, SESSIONS, TOOL, TRASH, formatAgo, isSnapshotPath, lastProgressLine, linkTitle } from "./helpers";
import { wikifyBlocked } from "./marks";
import { JOURNALS, JournalVolume, publishBlocked } from "./journalstate";
import type AlmagestPlugin from "./main";
import { ingestMessage, repairMessage, resolveMessage } from "./messages";
import {
	AREAS,
	Area,
	AreaLine,
	LintResult,
	LintSummary,
	PaletteState,
	Tone,
	TrashOutcome,
	TrashResult,
	VaultStatus,
	areaLine,
	lintSummary,
	paletteState,
	noteTitle,
	plural,
	trashOutcome,
} from "./palettestate";
import { confirmPublish } from "./publish";
import { Session, resume, sessionGroups } from "./sessions";

export const PALETTE_VIEW = "almagest-palette";
export const PALETTE_ICON = "map";

const REFRESH_MS = 30_000;
const EVENT_DELAY = 1500;

/** What change start prints: the work document. */
interface Started {
	ref: { id: string; title: string; path: string };
}

type Action = "ingest" | "checkout" | "lint" | "sync" | "repair" | "wikify" | "trash" | "return" | "publish" | "start" | "resume" | "migrate";

/** What `vault migrate --json` prints under "migration"; a dry run has no commit. */
interface Migration {
	moved: { from: string; to: string }[];
	edited: string[];
	warnings: string[];
	commit?: string;
}

/** The word that opens a session's line. */
const STATE_WORDS: Record<SessionState, string> = { "needs you": "Needs you", working: "Working", idle: "Idle", ended: "Ended", lost: "Lost" };

/** What a session's thread opens: the Duet conversation it runs in, else its session document. */
function opens(row: Session): string {
	return row.conversation?.path ?? row.path;
}

/** A session's title: its description, or "Untitled session" while it has none (the document's name is its date and id). */
function sessionTitle(row: Session): string {
	return row.description === row.file.basename ? "Untitled session" : plainLinks(row.description);
}

/** The icon of each area, on its home row and its page. */
const AREA_ICONS: Record<Area, string> = {
	changes: "git-pull-request",
	ingest: "inbox",
	health: "stethoscope",
	journals: "notebook-pen",
	library: "library",
	agents: "bot",
	note: "file-text",
};

/** The name of each area's page. */
const AREA_NAMES: Record<Area, string> = {
	changes: "Changes",
	ingest: "Ingest",
	health: "Wiki health",
	journals: "Journals",
	library: "Library",
	agents: "Agents",
	note: "This note",
};

/**
 * The Almagest palette: a home with one row per area, each the way into a page with the
 * area's numbers, actions, and lists. Its status comes from one `vault --json` call, and it
 * refreshes after vault events and every 30 seconds while it is open.
 */
export class PaletteView extends ItemView {
	/** The page the palette shows: its home, or an area. */
	private palettePage: Area | "home" = "home";
	private state: PaletteState | null = null;
	private error = "";
	/** The last progress line of each running work document and open session, by path. */
	private progress = new Map<string, string>();
	private sessions: SessionGroups<Session> = { open: [], recent: [], older: 0 };
	/** Whether the closed sessions show on the Agents page; they fold away at first. */
	private closedOpen = false;
	/** What the migration would do, while the vault waits for it. */
	private migration: Migration | null = null;
	/** The running subagents of each session, by the session's title. */
	private subagents = new Map<string, number>();
	private lint: LintSummary | null = null;
	private busy: Action | null = null;
	/** The folder of the checkout that Return proposes now. */
	private returning = "";
	private loading = false;
	private again = false;
	private readonly soon = debounce(() => void this.refresh(), EVENT_DELAY, true);

	constructor(leaf: WorkspaceLeaf, private plugin: AlmagestPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return PALETTE_VIEW;
	}

	getDisplayText(): string {
		return "Almagest";
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
		this.registerEvent(this.app.workspace.on("file-open", () => this.draw()));
		this.registerInterval(window.setInterval(() => void this.refresh(), REFRESH_MS));
		this.draw();
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
		this.draw();
	}

	private async readStatus(): Promise<void> {
		const needs = this.plugin.needs();
		if (needs !== "") {
			try {
				this.migration = needs === "migrate" ? (await this.plugin.almagest<{ migration: Migration }>(["vault", "migrate", "--dry-run"])).migration : null;
				this.error = "";
			} catch (e) {
				this.error = (e as Error).message;
			}
			return;
		}
		try {
			const out = await this.plugin.almagest<{ status: VaultStatus }>(["vault"]);
			const { rows, groups } = await sessionGroups(this.app, this.plugin.staleHours());
			const waiting = groups.open.filter((s) => s.state === "needs you").length;
			const state = paletteState(out.status, { open: groups.open.length, waiting });
			const progress = new Map<string, string>();
			for (const path of [...state.running.map((r) => r.path), ...groups.open.map((s) => s.row.path), ...groups.recent.map((s) => s.row.path)]) {
				const file = this.app.vault.getFileByPath(path);
				if (file) progress.set(path, plainLinks(lastProgressLine(await this.app.vault.cachedRead(file))));
			}
			const subagents = new Map<string, number>();
			for (const r of rows) {
				if (r.parent && r.status === "running") subagents.set(linkTitle(r.parent), (subagents.get(linkTitle(r.parent)) ?? 0) + 1);
			}
			this.state = state;
			this.progress = progress;
			this.sessions = groups;
			this.subagents = subagents;
			this.error = "";
		} catch (e) {
			this.error = (e as Error).message;
		}
		this.plugin.checkConversations();
	}

	/** Draws the page the palette shows. */
	draw(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("almagest-palette");
		const needs = this.plugin.needs();
		root.dataset.page = needs || this.palettePage;
		if (needs === "migrate") this.renderMigrate(root);
		else if (needs === "update") this.renderUpdate(root);
		else if (this.palettePage === "home") this.renderHome(root);
		else this.renderPage(root, this.palettePage);
	}

	/** Shows a page. (Not open: View.open is Obsidian's, which it calls with the view's container.) */
	private show(page: Area | "home"): void {
		this.palettePage = page;
		this.draw();
		this.contentEl.scrollTop = 0;
	}

	// A vault of another layout: the palette shows what it needs, in place of its home.

	private renderMigrate(root: HTMLElement): void {
		this.head(root, "folder-input", "Migrate this vault");
		if (this.error) root.createDiv({ cls: "almagest-error", text: `Almagest: ${this.error}` });
		const page = root.createDiv({ cls: "almagest-page" });
		this.lede(page, `This vault keeps sessions/, source-core/, and trash/ at its root. This version of Almagest keeps them in ${TOOL}/, so the root holds only the folders you use. Almagest waits until the vault is migrated.`);
		const m = this.migration;
		if (!m) {
			if (!this.error) this.empty(page, "Reading what the migration would move…");
			return;
		}
		this.tiles(page, [
			[m.moved.length, m.moved.length === 1 ? "file moves" : "files move"],
			[m.edited.length, m.edited.length === 1 ? "file changes" : "files change"],
		]);
		this.actions(page, (el) => this.button(el, "migrate", "Migrate the vault", "", () => this.migrate(), "cta"));
		const notes = page.createDiv({ cls: "almagest-quiet" });
		notes.setText(`One commit, after a snapshot of your edits. The links and Bases that name a moved file follow it; prose, code, and the trash stay as written. ${m.warnings.map((w) => w.charAt(0).toUpperCase() + w.slice(1) + ".").join(" ")}`.trim());
	}

	private renderUpdate(root: HTMLElement): void {
		this.head(root, "refresh-cw", "Update Almagest");
		const page = root.createDiv({ cls: "almagest-page" });
		this.lede(page, "A newer Almagest wrote this vault. Update Almagest in Obsidian's community plugins, and the agent plugin (claude plugin update almagest@nathanaday-almagest), then reload Obsidian.");
	}

	private async migrate(): Promise<void> {
		const { migration } = await this.plugin.almagest<{ migration: Migration }>(["vault", "migrate"]);
		new Notice(`Almagest: migrated the vault in one commit: ${plural(migration.moved.length, "file", "files")} moved into ${TOOL}/. Start a new agent session in the vault.`, 10_000);
	}

	/** A page's head: its icon and title, with the way back when there is a home to go to. */
	private head(root: HTMLElement, icon: string, title: string, back = false): void {
		const head = root.createDiv({ cls: "almagest-page-head" });
		if (back) {
			const button = head.createEl("button", { cls: "almagest-back clickable-icon", attr: { "aria-label": "Back to Almagest" } });
			setIcon(button, "chevron-left");
			button.onclick = () => this.show("home");
		}
		setIcon(head.createDiv({ cls: "almagest-page-icon" }), icon);
		head.createDiv({ cls: "almagest-page-title", text: title });
	}

	// The home: one row per area, each a way into its page.

	private renderHome(root: HTMLElement): void {
		if (this.error) root.createDiv({ cls: "almagest-error", text: `Almagest: ${this.error}` });
		const s = this.state;
		if (!s) {
			if (!this.error) root.createDiv({ cls: "almagest-empty", text: "Reading the vault…" });
			return;
		}
		const agents = this.plugin.conversations.list().length;
		const hasNote = this.app.workspace.getActiveFile() !== null;
		const groups: Area[][] = [AREAS.filter((a) => a !== "note"), ["note"]];
		for (const group of groups) {
			const nav = root.createDiv({ cls: "almagest-nav" });
			for (const area of group) this.navRow(nav, area, areaLine(area, s, agents, hasNote));
		}
	}

	private navRow(parent: HTMLElement, area: Area, a: AreaLine): void {
		const row = parent.createDiv({ cls: "almagest-nav-row", attr: { role: "button", tabindex: "0" } });
		row.dataset.area = area;
		setIcon(row.createDiv({ cls: "almagest-nav-icon" }), AREA_ICONS[area]);
		const text = row.createDiv({ cls: "almagest-nav-text" });
		text.createDiv({ cls: "almagest-nav-name", text: a.name });
		text.createDiv({ cls: "almagest-nav-line", text: a.line });
		// The chip's cell stays when there is no chip, so every chevron lines up.
		const badge = row.createDiv({ cls: "almagest-nav-badge" });
		if (a.count > 0) this.chip(badge, String(a.count), a.tone);
		setIcon(row.createDiv({ cls: "almagest-nav-chevron" }), "chevron-right");
		row.onclick = () => this.show(area);
		row.onkeydown = (evt) => {
			if (evt.key === "Enter" || evt.key === " ") {
				evt.preventDefault();
				this.show(area);
			}
		};
	}

	// A page: its head, its numbers, its actions, and its lists.

	private renderPage(root: HTMLElement, area: Area): void {
		this.head(root, AREA_ICONS[area], AREA_NAMES[area], true);
		if (this.error) root.createDiv({ cls: "almagest-error", text: `Almagest: ${this.error}` });
		const s = this.state;
		if (!s) {
			if (!this.error) root.createDiv({ cls: "almagest-empty", text: "Reading the vault…" });
			return;
		}
		const page = root.createDiv({ cls: "almagest-page" });
		switch (area) {
			case "changes":
				return this.renderChanges(page, s);
			case "ingest":
				return this.renderIngest(page, s);
			case "health":
				return this.renderHealth(page, s);
			case "journals":
				return this.renderJournals(page, s);
			case "library":
				return this.renderLibrary(page, s);
			case "agents":
				return this.renderAgents(page, s);
			case "note":
				return this.renderNote(page, s);
		}
	}

	private renderChanges(page: HTMLElement, s: PaletteState): void {
		this.lede(page, "Agents propose each edit of the wiki as a change. Open one to read it, then Approve or Cancel in the document.");
		this.tiles(page, [
			[s.proposed.length, "to review"],
			[s.running.length, "running"],
		]);
		if (s.proposed.length === 0 && s.running.length === 0) {
			this.empty(page, "No change waits for you.");
			return;
		}
		const review = this.list(page, "To review", s.proposed.length);
		for (const r of s.proposed) this.item(review, { title: r.title, path: r.path });
		const running = this.list(page, "Running", s.running.length);
		for (const r of s.running) {
			this.item(running, { title: r.title, path: r.path, meta: [r.kind, this.progress.get(r.path) || "no step yet"].filter((x) => x).join(" · ") });
		}
	}

	private renderIngest(page: HTMLElement, s: PaletteState): void {
		this.lede(page, `Files you drop in ${INGEST} become cited pages of the wiki. An agent captures each one and proposes the pages as one change.`);
		this.tiles(page, [
			[s.ingest.length, s.ingest.length === 1 ? "file waiting" : "files waiting"],
			[s.pending, s.pending === 1 ? "source to absorb" : "sources to absorb"],
		]);
		const files = s.ingest.length;
		this.actions(page, (el) =>
			this.button(el, "ingest", files > 0 ? `Ingest ${plural(files, "file", "files")}` : "Ingest", files > 0 ? "" : `${INGEST} holds no file.`, () => this.ingest(), "cta"),
		);
		if (files === 0) {
			this.empty(page, `${INGEST} is empty. Drop papers, PDFs, or notes into it, then press Ingest.`);
			return;
		}
		const list = this.list(page, `In ${INGEST}`, files);
		for (const name of s.ingest) this.item(list, { title: name, path: `${INGEST}${name}` });
	}

	private renderHealth(page: HTMLElement, s: PaletteState): void {
		this.lede(page, "Wiki lint checks every document: its links, its citations, and whether its sources changed after it. Sync writes the views and the statuses again.");
		this.tiles(page, [[s.problems, s.problems === 1 ? "error" : "errors"]]);
		this.actions(page, (el) => {
			this.button(el, "lint", "Run wiki lint", "", () => this.runLint(), "cta");
			this.button(el, "sync", "Sync the vault", "", () => this.plugin.sync(true));
		});
		const lint = this.lint;
		if (!lint) return;
		const result = page.createDiv({ cls: "almagest-result" });
		result.createDiv({ cls: "almagest-result-title", text: lint.counts });
		if (lint.first.length > 0) {
			const ul = result.createEl("ul", { cls: "almagest-list" });
			for (const f of lint.first) {
				this.item(ul, { title: f.doc.title || f.doc.path, path: f.doc.path, meta: f.message, chip: [f.check, f.severity === "error" ? "warning" : "muted"] });
			}
		}
		if (lint.more > 0) result.createDiv({ cls: "almagest-quiet", text: `${lint.more} more: ask an agent to review the wiki for all of them.` });
		if (lint.repairable > 0) {
			this.actions(result, (el) => this.button(el, "repair", `Repair ${plural(lint.repairable, "finding", "findings")} with an agent`, "", () => this.repair()));
		}
	}

	private renderJournals(page: HTMLElement, s: PaletteState): void {
		this.lede(page, `Your own writing, one volume per folder in ${JOURNALS}/. Agents read it and never edit it. Publish a volume when the wiki should learn from it.`);
		this.tiles(page, [
			[s.journals.length, s.journals.length === 1 ? "volume" : "volumes"],
			[s.toPublish, "to publish"],
		]);
		if (s.journals.length === 0) {
			this.empty(page, `No journal yet. Make a folder in ${JOURNALS}/ and write in it.`);
			return;
		}
		const list = this.list(page, "Volumes", s.journals.length);
		for (const vol of s.journals) this.renderVolume(list, vol);
	}

	private renderVolume(list: HTMLElement, vol: JournalVolume): void {
		const edition = vol.edition ? this.app.metadataCache.getFirstLinkpathDest(vol.edition, "") : null;
		const why = publishBlocked(vol);
		const li = this.item(list, {
			title: vol.name,
			chip: vol.changed ? ["changed", "accent"] : undefined,
			meta: `${plural(vol.notes, "note", "notes")} · ${vol.edition ? "last edition " : "never published"}`,
			action: {
				name: "publish",
				text: this.plugin.publishing === vol.volume ? "Publish…" : "Publish",
				why: why || (this.busy || this.plugin.publishing ? "Another action runs." : ""),
				run: () => confirmPublish(this.plugin, vol),
			},
		});
		li.dataset.volume = vol.volume;
		li.dataset.changed = String(vol.changed);
		if (vol.edition) {
			const meta = li.querySelector<HTMLElement>(".almagest-item-meta")!;
			if (edition) this.link(meta, vol.edition, edition.path);
			else meta.appendText(vol.edition);
		}
	}

	private renderLibrary(page: HTMLElement, s: PaletteState): void {
		this.lede(page, `The librarian picks the pages that serve a request, in reading order, and copies them for you to read and mark up. Return proposes your edits as one change and keeps the checkout in ${RETURNED}/.`);
		this.tiles(page, [
			[s.checkouts.length, "out"],
			[s.returned, "returned"],
		]);
		// The modal asks first; the action runs once it has the request.
		this.actions(page, (el) => {
			const button = this.buttonEl(el, "checkout", "Check out material", "", "cta");
			button.onclick = () => this.askCheckout();
		});
		if (s.checkouts.length === 0) {
			this.empty(page, s.returned > 0 ? "No checkout is out." : "No checkout yet.");
		} else {
			const list = this.list(page, "Out", s.checkouts.length);
			for (const c of s.checkouts) this.renderCheckout(list, c);
		}
		if (s.checkouts.length + s.returned > 0) {
			const ledger = page.createDiv({ cls: "almagest-quiet" });
			this.link(ledger, "The ledger", LEDGER);
			ledger.appendText(" lists every checkout, out and returned.");
		}
	}

	private renderCheckout(list: HTMLElement, c: Checkout): void {
		const li = this.item(list, {
			title: c.name,
			path: indexPath(c),
			meta: [c.date, plural(c.documents, "document", "documents"), `${c.edited} edited`].join(" · "),
			action: {
				name: "return",
				text: this.busy === "return" && this.returning === c.folder ? "Return…" : "Return",
				why: this.busy || this.plugin.publishing ? "Another action runs." : "",
				run: () => {
					this.returning = c.folder;
					void this.act("return", () => returnCheckout(this.plugin, c));
				},
			},
		});
		li.dataset.folder = c.folder;
	}

	private renderAgents(page: HTMLElement, s: PaletteState): void {
		const working = this.plugin.conversations.list();
		const { open, recent, older } = this.sessions;
		this.lede(page, "The agents Almagest started for you, and the agent sessions in this vault. A session that needs you waits for your answer in its terminal.");
		this.tiles(page, [
			[s.waiting, s.waiting === 1 ? "needs you" : "need you"],
			[s.sessions, s.sessions === 1 ? "live session" : "live sessions"],
		]);
		this.actions(page, (el) => this.button(el, "start", "Start an agent", "", () => this.plugin.startAgent(), "cta"));
		if (working.length === 0 && open.length === 0 && recent.length === 0) this.empty(page, "No agent session is open.");

		const started = this.list(page, "Started here", working.length);
		for (const c of working) {
			this.thread(started, { title: noteTitle(c.path), path: c.path, state: "working", time: "", preview: `${c.label} · working in Duet` }).addClass("almagest-agent");
		}
		const now = new Date();
		const live = this.list(page, "Sessions", open.length);
		for (const { row, state } of open) {
			const subs = this.subagents.get(row.file.basename) ?? 0;
			this.thread(live, {
				title: sessionTitle(row),
				path: opens(row),
				state,
				time: formatAgo(row.updated, now),
				preview: [STATE_WORDS[state], subs > 0 ? `+${plural(subs, "subagent", "subagents")}` : "", this.progress.get(row.path) ?? ""].filter((x) => x).join(" · "),
			});
		}
		if (recent.length > 0) {
			// The closed sessions fold away; the fold stays as the user left it while the palette is open.
			const fold = page.createEl("details", { cls: "almagest-fold" });
			fold.open = this.closedOpen;
			fold.addEventListener("toggle", () => (this.closedOpen = fold.open));
			const head = fold.createEl("summary", { cls: "almagest-list-head" });
			setIcon(head.createSpan({ cls: "almagest-fold-chevron" }), "chevron-right");
			head.createSpan({ text: "Closed in the last 2 hours" });
			head.createSpan({ cls: "almagest-list-count", text: String(recent.length) });
			const closed = fold.createEl("ul", { cls: "almagest-list" });
			// An open session runs in its terminal already, so only a closed one offers Resume.
			for (const { row, state } of recent) {
				this.thread(closed, {
					title: sessionTitle(row),
					path: opens(row),
					state,
					time: formatAgo(row.ended || row.updated, now),
					preview: [STATE_WORDS[state], this.progress.get(row.path) ?? ""].filter((x) => x).join(" · "),
					action: { name: "resume", text: "Resume", run: () => void resume(this.plugin, row) },
				});
			}
		}
		if (older > 0) {
			const more = page.createDiv({ cls: "almagest-quiet" });
			this.link(more, `${plural(older, "older session", "older sessions")} in ${SESSIONS}/`, `${SESSIONS}/Sessions.base`);
		}
	}

	/**
	 * One agent session as a message thread: a round avatar that shows its state (it glows
	 * while the agent works, and turns gray once the session closes), the title with its
	 * time, and a line on where it stands. The row opens the session's document.
	 */
	private thread(list: HTMLElement, t: { title: string; path: string; state: SessionState; time: string; preview: string; action?: { name: Action; text: string; run: () => void } }): HTMLElement {
		const li = list.createEl("li", { cls: "almagest-thread", attr: { role: "link", tabindex: "0", "aria-label": `${t.title}: ${t.preview}` } });
		li.dataset.state = t.state.replace(" ", "-");
		li.toggleClass("is-closed", t.state === "ended" || t.state === "lost");
		setIcon(li.createDiv({ cls: "almagest-avatar" }), "bot");
		const body = li.createDiv({ cls: "almagest-thread-body" });
		const top = body.createDiv({ cls: "almagest-thread-top" });
		top.createSpan({ cls: "almagest-thread-title", text: t.title });
		if (t.time) top.createSpan({ cls: "almagest-thread-time", text: t.time });
		const bottom = body.createDiv({ cls: "almagest-thread-bottom" });
		bottom.createDiv({ cls: "almagest-thread-preview", text: t.preview, attr: { title: t.preview } });
		const go = (evt: MouseEvent | KeyboardEvent) => void this.openPath(t.path, evt.metaKey || evt.ctrlKey);
		li.onclick = go;
		li.onkeydown = (evt) => {
			if (evt.key === "Enter" || evt.key === " ") {
				evt.preventDefault();
				go(evt);
			}
		};
		if (t.action) {
			const a = t.action;
			const button = bottom.createEl("button", { cls: "almagest-item-action", text: a.text });
			button.dataset.action = a.name;
			button.onclick = (evt) => {
				evt.stopPropagation();
				a.run();
			};
		}
		return li;
	}

	private renderNote(page: HTMLElement, s: PaletteState): void {
		this.lede(page, `Wikify marks a copy of the open note with what the wiki knows. Safe delete moves the note to ${TRASH}/ when nothing links it.`);
		this.tiles(page, [[s.trash, s.trash === 1 ? "file in trash" : "files in trash"]]);
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			this.empty(page, "Open a note in the editor first.");
			return;
		}
		this.actions(page, (el) => {
			this.button(el, "wikify", "Wikify this note", wikifyBlocked(file.path, this.app.vault.configDir), () => this.plugin.wikify.wikify(file), "cta");
			this.button(el, "trash", "Safe delete this note", "", () => this.safeDelete(), "danger");
		});
	}

	// The parts every page is made of.

	private lede(parent: HTMLElement, text: string): void {
		parent.createDiv({ cls: "almagest-lede", text });
	}

	private tiles(parent: HTMLElement, tiles: [number, string][]): void {
		const el = parent.createDiv({ cls: "almagest-tiles" });
		for (const [n, label] of tiles) {
			const tile = el.createDiv({ cls: "almagest-tile" });
			tile.createDiv({ cls: "almagest-tile-number", text: String(n) });
			tile.createDiv({ cls: "almagest-tile-label", text: label });
		}
	}

	private actions(parent: HTMLElement, fill: (el: HTMLElement) => void): void {
		fill(parent.createDiv({ cls: "almagest-actions" }));
	}

	/** A full-width action button. why disables it; a running action disables every one. */
	private button(parent: HTMLElement, name: Action, text: string, why: string, run: () => Promise<void>, kind: "cta" | "danger" | "" = ""): void {
		this.buttonEl(parent, name, text, why, kind).onclick = () => void this.act(name, run);
	}

	/** The button of an action, with no click handler yet. */
	private buttonEl(parent: HTMLElement, name: Action, text: string, why: string, kind: "cta" | "danger" | "" = ""): HTMLButtonElement {
		const button = parent.createEl("button", { cls: "almagest-button", text: this.busy === name ? `${text}…` : text });
		button.dataset.action = name;
		if (kind === "cta") button.addClass("mod-cta");
		if (kind === "danger") button.addClass("almagest-button-danger");
		if (why || this.busy || this.plugin.publishing) {
			button.disabled = true;
			button.setAttr("title", why || "Another action runs.");
		}
		return button;
	}

	private empty(parent: HTMLElement, text: string): void {
		parent.createDiv({ cls: "almagest-empty", text });
	}

	private chip(parent: HTMLElement, text: string, tone: Tone): HTMLElement {
		const chip = parent.createSpan({ cls: "almagest-chip", text });
		chip.dataset.tone = tone;
		return chip;
	}

	/** A list under a label that counts its items; nothing when it holds none. */
	private list(parent: HTMLElement, label: string, n: number): HTMLElement {
		if (n === 0) return parent.createEl("ul", { cls: "almagest-list" });
		const head = parent.createDiv({ cls: "almagest-list-head" });
		head.createSpan({ text: label });
		head.createSpan({ cls: "almagest-list-count", text: String(n) });
		return parent.createEl("ul", { cls: "almagest-list" });
	}

	/** One item of a list: a title (a link when it has a path), a line under it, a chip, and an action. */
	private item(
		list: HTMLElement,
		it: {
			title: string;
			path?: string;
			meta?: string;
			chip?: [string, Tone];
			action?: { name: Action; text: string; why: string; run: () => void };
		},
	): HTMLElement {
		const li = list.createEl("li", { cls: "almagest-item" });
		const main = li.createDiv({ cls: "almagest-item-main" });
		const top = main.createDiv({ cls: "almagest-item-top" });
		const title = top.createSpan({ cls: "almagest-item-title" });
		if (it.path) this.link(title, it.title, it.path);
		else title.setText(it.title);
		if (it.chip) this.chip(top, it.chip[0], it.chip[1]);
		if (it.meta !== undefined) main.createDiv({ cls: "almagest-item-meta", text: it.meta });
		if (it.action) {
			const a = it.action;
			const button = li.createEl("button", { cls: "almagest-item-action", text: a.text });
			button.dataset.action = a.name;
			if (a.why) {
				button.disabled = true;
				button.setAttr("title", a.why);
			} else {
				button.addClass("mod-cta");
			}
			button.onclick = () => a.run();
		}
		return li;
	}

	private link(parent: HTMLElement, title: string, path: string): HTMLElement {
		const a = parent.createEl("a", { cls: "almagest-link", text: title, href: "#" });
		a.setAttr("title", path);
		a.onclick = (evt) => {
			evt.preventDefault();
			void this.openPath(path, evt.metaKey || evt.ctrlKey);
		};
		return a;
	}

	private async act(name: Action, run: () => Promise<void>): Promise<void> {
		if (this.busy || this.plugin.publishing) return;
		this.busy = name;
		this.draw();
		try {
			await run();
		} catch (e) {
			new Notice(`Almagest: ${(e as Error).message}`, 10_000);
		} finally {
			this.busy = null;
			this.draw();
			void this.refresh();
		}
	}

	// Actions

	private async ingest(): Promise<void> {
		const files = this.state?.ingest ?? [];
		if (files.length === 0) return;
		const doc = await this.start(["change", "start", "--kind", "ingest", ...files.map((f) => `--file=${f}`)]);
		await this.plugin.runAgent(ingestMessage(doc), `Agent · ${doc.title}`, "ingest");
	}

	private askCheckout(): void {
		new CheckoutModal(this.app, (request) => void this.act("checkout", () => startCheckout(this.plugin, request))).open();
	}

	private async runLint(): Promise<void> {
		this.lint = lintSummary(await this.plugin.almagest<LintResult>(["lint"]));
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
		const out = await this.plugin.almagest<{ trash: TrashResult }>(["vault", "trash", arg], [2]);
		const outcome = trashOutcome(out.trash);
		if (outcome.kind === "linked") {
			const agent = () => {
				const docs = outcome.backlinks.filter((b) => !outcome.yours.includes(b));
				void this.act("trash", () => this.plugin.runAgent(resolveMessage(outcome, docs, outcome.yours), `Agent · Remove ${outcome.title}`, "remove"));
			};
			new BacklinksModal(this.app, outcome, (path) => void this.openPath(path, false), outcome.agent ? agent : null).open();
			return;
		}
		new Notice(`Almagest: ${outcome.line}`, outcome.kind === "error" ? 10_000 : 6000);
	}

	/** Starts a work document and opens it. */
	private async start(args: string[]): Promise<{ id: string; title: string; path: string }> {
		const { ref } = await this.plugin.almagest<Started>(args);
		await this.openPath(ref.path, true);
		return ref;
	}

	private openPath(path: string, newTab: boolean): Promise<void> {
		return this.plugin.openWhenSeen(path, newTab);
	}
}

/** The files that keep a file from safe delete, and the agent that resolves the documents among them. */
class BacklinksModal extends Modal {
	constructor(
		app: App,
		private outcome: Extract<TrashOutcome, { kind: "linked" }>,
		private show: (path: string) => void,
		private resolve: (() => void) | null,
	) {
		super(app);
	}

	onOpen(): void {
		const { outcome } = this;
		this.setTitle(`${outcome.title} stays`);
		const el = this.contentEl;
		el.addClass("almagest-backlinks");
		el.createEl("p", {
			text: `${plural(outcome.backlinks.length, "file links", "files link")} ${outcome.path}, so safe delete moved nothing. Point each link elsewhere, or drop it; then the file can go to trash/.`,
		});
		if (outcome.yours.length > 0) {
			el.createEl("p", {
				text: `The links in your own notes are yours to fix: an agent edits knowledge documents only.`,
			});
		}
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
			if (outcome.yours.includes(b)) li.createSpan({ cls: "almagest-backlinks-type", text: " yours to fix" });
			else if (b.type) li.createSpan({ cls: "almagest-backlinks-type", text: ` ${b.kind || b.type}` });
		}
		const buttons = el.createDiv({ cls: "almagest-backlinks-buttons" });
		buttons.createEl("button", { text: "Close" }).onclick = () => this.close();
		const resolve = this.resolve;
		if (!resolve) return;
		const go = buttons.createEl("button", { cls: "mod-cta", text: "Resolve with an agent" });
		go.onclick = () => {
			this.close();
			resolve();
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
