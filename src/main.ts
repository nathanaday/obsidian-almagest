import { App, FileSystemAdapter, Modal, Notice, Plugin, debounce } from "obsidian";
import { Badges } from "./badges";
import { ChangeBar } from "./changebar";
import { AtlasError, findBinary, runAtlas } from "./cli";
import { GraphColors } from "./graphcolors";
import { GRAPH_MODES, isGraphMode } from "./graphgroups";
import { CanvasBar } from "./canvasbar";
import { LAYOUT, Synced, isWatchedPath, layoutName, layoutOf, normalTag, syncSummary, syncedPaths, waitingLabel } from "./helpers";
import { mentionEditor, mentionReading } from "./mentions";
import { repoProcessor } from "./repo";
import { SESSIONS_VIEW, SessionsView, sessionGroups } from "./sessions";
import { AgentConfig, legacyPreferences, startCommand } from "./agents";
import { openTerminal } from "./launcher";
import { NewThreadModal } from "./newthread";
import { AtlasSettingTab, AtlasSettings, DEFAULT_SETTINGS } from "./settings";
import { NAV_ICON, TAG_NAV_VIEW, TagNavigator } from "./tagnav";
import { ViewFolders } from "./viewfolders";
import { ThreadBar } from "./threadbar";

const SYNC_DELAY = 2000;
const LEGACY_KEYS = ["agentCommand", "terminal", "terminalCommand"];
// A change to a path the last sync wrote, this soon after it, is that sync's own write.
const ECHO_WINDOW = 5000;

interface MigrationReport {
	vault: string;
	from?: string;
	threads?: number;
	specs?: number;
	task_lists?: number;
	verifications?: number;
	chords?: number;
	topics?: number;
	notes?: number;
	documents: number;
	events: number;
	assets: number;
	tags?: { scope: string; tag: string }[] | null;
	retitles?: { old: string; new: string }[] | null;
	inbox?: string[] | null;
	scratchpad?: string[] | null;
	warnings?: string[] | null;
	commit?: string;
	problems?: number;
}

export default class AtlasPlugin extends Plugin {
	settings: AtlasSettings = { ...DEFAULT_SETTINGS };
	/** The agent settings of 8.0.2 and 8.0.3, kept in data.json until they move to the vault's config file. */
	private legacy: Record<string, unknown> | null = null;
	badges!: Badges;
	viewFolders!: ViewFolders;
	graphColors!: GraphColors;

	private syncing = false;
	private syncTimer: number | null = null;
	private pending = new Set<string>();
	private echoes = new Set<string>();
	private echoUntil = 0;
	private lastAutoError = "";

	private sessionsRibbon: HTMLElement | null = null;
	private statusItem: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new AtlasSettingTab(this.app, this));

		this.badges = this.addChild(new Badges(this.app));
		this.badges.setEnabled(this.settings.badges);
		this.addChild(new ChangeBar(this));
		const threadBar = this.addChild(new ThreadBar(this));
		this.addChild(new CanvasBar(this));
		this.addCommand({
			id: "copy-handoff",
			name: "Copy the hand-off line of this thread or chord",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
				if (fm?.type !== "stub" && fm?.type !== "chord") return false;
				if (!checking) threadBar.copyActive();
				return true;
			},
		});
		this.viewFolders = this.addChild(new ViewFolders(this.app));
		this.viewFolders.setEnabled(this.settings.viewFolders);
		this.registerMarkdownCodeBlockProcessor("atlas-repo", repoProcessor(this));

		this.graphColors = this.addChild(new GraphColors(this));
		for (const { mode, label } of GRAPH_MODES) {
			this.addCommand({
				id: `graph-colors-${mode}`,
				name: mode === "off" ? "Stop coloring the graph" : `Color the graph by ${label.toLowerCase()}`,
				callback: () => void this.graphColors.setMode(mode),
			});
		}

		this.addRibbonIcon("refresh-cw", "Atlas: sync the vault", () => void this.sync(true));
		this.addCommand({ id: "sync", name: "Sync the vault", callback: () => void this.sync(true) });

		this.registerView(
			TAG_NAV_VIEW,
			(leaf) =>
				new TagNavigator(
					leaf,
					(tags) => void this.graphColors.setFocus(tags),
					() => void this.focusGraph(),
				),
		);
		this.addRibbonIcon(NAV_ICON, "Atlas: open the Atlas navigator", () => void this.openTags());
		this.addCommand({ id: "open-tags", name: "Open the Atlas navigator", callback: () => void this.openTags() });
		// A click on a #tag opens the navigator at it, when the setting asks.
		this.registerDomEvent(document, "click", (evt) => this.onTagClick(evt), { capture: true });

		this.addCommand({
			id: "start-agent",
			name: "Start an agent on this thread or chord",
			checkCallback: (checking) => {
				const target = this.activeWork();
				if (!target) return false;
				if (!checking) void this.startAgent(target.type, target.id);
				return true;
			},
		});
		this.addCommand({
			id: "new-thread-in-chord",
			name: "New thread in this chord",
			checkCallback: (checking) => {
				const chord = this.activeChord();
				if (!chord) return false;
				if (!checking) this.newThread(chord);
				return true;
			},
		});

		this.registerView(SESSIONS_VIEW, (leaf) => new SessionsView(leaf, this));
		this.sessionsRibbon = this.addRibbonIcon("bot", "Atlas: open the sessions", () => void this.openSessions());
		this.sessionsRibbon.addClass("atlas-sessions-ribbon");
		this.addCommand({ id: "open-sessions", name: "Open the sessions", callback: () => void this.openSessions() });
		this.statusItem = this.addStatusBarItem();
		this.statusItem.addClass("atlas-status-waiting");
		this.statusItem.onClickEvent(() => void this.openSessions());

		this.addCommand({ id: "migrate", name: "Migrate this vault to the 8.0 layout", callback: () => void this.migrate() });

		this.registerEditorExtension(mentionEditor);
		this.registerMarkdownPostProcessor(mentionReading);

		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file.path.startsWith("sessions/")) this.refreshSessions();
				this.onDocChange(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.refreshSessions();
				this.onDocChange(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.refreshSessions();
				this.onDocChange(file.path);
				this.onDocChange(oldPath);
			}),
		);
		this.registerInterval(window.setInterval(() => this.sessionViews().forEach((v) => v.tick()), 30_000));
		this.app.workspace.onLayoutReady(() => {
			this.refreshSessions();
			this.checkLayout();
			void this.moveLegacyPreferences();
		});
		// The cache may finish its first read after the layout is ready.
		const first = this.app.metadataCache.on("resolved", () => {
			this.app.metadataCache.offref(first);
			this.refreshSessions();
		});
		this.registerEvent(first);
	}

	onunload(): void {
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
	}

	/** Colors the graph by the navigator's tags, and opens the graph. */
	private async focusGraph(): Promise<void> {
		await this.graphColors.setMode("focus");
		const open = this.app.workspace.getLeavesOfType("graph")[0];
		if (open) this.app.workspace.revealLeaf(open);
		else (this.app as unknown as { commands?: { executeCommandById?(id: string): void } }).commands?.executeCommandById?.("graph:open");
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as (Partial<AtlasSettings> & { folderPages?: boolean }) | null;
		const old = Object.entries(saved ?? {}).filter(([k]) => LEGACY_KEYS.includes(k));
		this.legacy = old.length > 0 ? Object.fromEntries(old) : null;
		this.settings = { ...DEFAULT_SETTINGS };
		// Only the keys this version knows; a 6.x key goes at the next save.
		for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AtlasSettings)[]) {
			if (saved && saved[key] !== undefined) (this.settings as unknown as Record<string, unknown>)[key] = saved[key];
		}
		if (saved?.folderPages !== undefined && saved.viewFolders === undefined) this.settings.viewFolders = saved.folderPages;
		if (!isGraphMode(this.settings.graphColors)) this.settings.graphColors = DEFAULT_SETTINGS.graphColors;
		for (const key of ["graphOwned", "focusTags"] as const) {
			const list = this.settings[key];
			this.settings[key] = Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData({ ...this.legacy, ...this.settings });
	}

	/** Runs one atlas command in this vault and returns its JSON. */
	atlas<T>(args: string[]): Promise<T> {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			return Promise.reject(new AtlasError("this vault is not a folder on disk"));
		}
		return runAtlas<T>(findBinary(this.settings.binaryPath), adapter.getBasePath(), args);
	}

	// Sync

	/** A manual sync heals everything; an automatic one runs the steps that read no git. */
	async sync(manual: boolean): Promise<void> {
		if (this.syncing) {
			if (manual) new Notice("Atlas: a sync is running.");
			return;
		}
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
		this.syncTimer = null;
		this.syncing = true;
		this.pending.clear();
		let wrote: string[] = [];
		try {
			const args = manual ? ["vault", "sync"] : ["vault", "sync", "--views"];
			const out = await this.atlas<{ synced: Synced }>(args);
			wrote = syncedPaths(out.synced);
			this.lastAutoError = "";
			if (manual) new Notice(`Atlas: ${syncSummary(out.synced)}`);
		} catch (e) {
			const message = (e as Error).message;
			// A background sync that fails the same way again stays quiet.
			if (manual || message !== this.lastAutoError) new Notice(`Atlas: ${message}`);
			if (!manual) this.lastAutoError = message;
		} finally {
			this.syncing = false;
			this.echoes = new Set(wrote);
			this.echoUntil = Date.now() + ECHO_WINDOW;
			const left: string[] = [];
			for (const p of this.pending) {
				if (this.echoes.has(p)) this.echoes.delete(p);
				else left.push(p);
			}
			this.pending.clear();
			if (left.length > 0) this.scheduleSync();
		}
	}

	private onDocChange(path: string): void {
		if (!this.settings.syncOnChange || !isWatchedPath(path) || !this.migrated()) return;
		if (this.syncing) {
			this.pending.add(path);
			return;
		}
		if (Date.now() < this.echoUntil && this.echoes.has(path)) {
			this.echoes.delete(path);
			return;
		}
		this.scheduleSync();
	}

	private scheduleSync(): void {
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
		this.syncTimer = window.setTimeout(() => {
			this.syncTimer = null;
			void this.sync(false);
		}, SYNC_DELAY);
	}

	// Layout

	/** The layout the vault document records; this plugin's when there is none to read. */
	private layout(): number {
		const atlas = this.app.vault.getFileByPath("Atlas.md");
		if (!atlas) return LAYOUT;
		return layoutOf(this.app.metadataCache.getFileCache(atlas)?.frontmatter);
	}

	/** Whether the vault has the 8.0 layout. */
	private migrated(): boolean {
		return this.layout() >= LAYOUT;
	}

	private checkLayout(): void {
		if (this.migrated()) return;
		const notice = new Notice("", 0);
		const el = notice.messageEl;
		el.createDiv({ text: `Atlas: this vault has the ${layoutName(this.layout())} layout. This plugin needs the 8.0 layout: threads and chords.` });
		const button = el.createEl("button", { text: "Show the migration", cls: "mod-cta atlas-notice-button" });
		button.onclick = () => {
			notice.hide();
			void this.migrate();
		};
	}

	private async migrate(): Promise<void> {
		try {
			const report = await this.atlas<MigrationReport>(["vault", "migrate", "--dry-run"]);
			new MigrationModal(this.app, report, async () => {
				try {
					const done = await this.atlas<MigrationReport>(["vault", "migrate"]);
					new Notice(`Atlas: migrated in one commit, ${String(done.commit ?? "").slice(0, 7)}.${done.problems ? ` Lint finds ${done.problems} errors.` : ""}`, 10_000);
				} catch (e) {
					new Notice(`Atlas: ${(e as Error).message}`, 10_000);
				}
			}).open();
		} catch (e) {
			new Notice(`Atlas: ${(e as Error).message}`, 10_000);
		}
	}

	// Tags

	private onTagClick(evt: MouseEvent): void {
		if (!this.settings.tagClick || !(evt.target instanceof Element)) return;
		const el = evt.target.closest<HTMLElement>("a.tag, .cm-hashtag");
		if (!el) return;
		let tag = el.getAttribute("href") ?? el.textContent ?? "";
		if (el.classList.contains("cm-hashtag")) {
			// The editor splits a tag into spans: the # and the name.
			const line = el.closest(".cm-line");
			const parts = line ? Array.from(line.querySelectorAll<HTMLElement>(".cm-hashtag")) : [el];
			const i = parts.indexOf(el);
			const begin = parts[i]?.classList.contains("cm-hashtag-begin") ? i : i - 1;
			tag = (parts[begin]?.textContent ?? "") + (parts[begin + 1]?.textContent ?? "");
		}
		tag = normalTag(tag);
		if (!tag) return;
		evt.preventDefault();
		evt.stopPropagation();
		void this.openTags(tag);
	}

	private async openTags(tag?: string): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(TAG_NAV_VIEW)[0];
		if (!leaf) {
			const left = workspace.getLeftLeaf(false);
			if (!left) return;
			await left.setViewState({ type: TAG_NAV_VIEW, active: true });
			leaf = left;
		}
		await workspace.revealLeaf(leaf);
		if (tag && leaf.view instanceof TagNavigator) leaf.view.show(tag);
	}

	// Sessions

	private sessionViews(): SessionsView[] {
		return this.app.workspace
			.getLeavesOfType(SESSIONS_VIEW)
			.map((leaf) => leaf.view)
			.filter((v): v is SessionsView => v instanceof SessionsView);
	}

	private refreshSessions = debounce(
		() => {
			void sessionGroups(this.app, this.staleHours()).then(({ groups }) => {
				const waiting = groups.open.filter((s) => s.state === "needs you").length;
				this.statusItem?.setText(waiting > 0 ? waitingLabel(waiting) : "");
				this.statusItem?.toggleClass("is-hidden", waiting === 0);
				if (this.sessionsRibbon) {
					if (waiting > 0) this.sessionsRibbon.dataset.atlasCount = String(waiting);
					else delete this.sessionsRibbon.dataset.atlasCount;
				}
			});
			this.sessionViews().forEach((v) => void v.render());
		},
		500,
		true,
	);

	/** How long a session with no recorded process may go quiet before it counts as gone. */
	staleHours(): number {
		const atlas = this.app.vault.getFileByPath("Atlas.md");
		const n = Number(atlas ? this.app.metadataCache.getFileCache(atlas)?.frontmatter?.stale_hours : 0);
		return n > 0 ? n : 12;
	}

	// Agents

	/** The agent preferences: the vault's config file over ~/.atlas/config.json. */
	agentConfig(): Promise<AgentConfig> {
		return this.atlas<AgentConfig>(["config"]);
	}

	/** Sets or unsets (value "") one agent preference, in the vault's file or the global one. */
	async setPreference(key: string, value: string, global: boolean): Promise<AgentConfig> {
		const args = value ? ["config", "set", key, value] : ["config", "unset", key];
		return this.atlas<AgentConfig>(global ? [...args, "--global"] : args);
	}

	/** Moves the agent settings of 8.0.2 and 8.0.3 into the vault's config file, once. */
	private async moveLegacyPreferences(): Promise<void> {
		const saved = this.legacy;
		if (!saved) return;
		try {
			const config = await this.agentConfig();
			for (const [key, value] of legacyPreferences(saved, config.vault)) await this.setPreference(key, value, false);
			this.legacy = null;
			await this.saveSettings();
		} catch (e) {
			console.warn("Atlas: the agent settings did not move to .atlas/config.json", e);
		}
	}

	/** Runs a command in a new terminal; off macOS, or when that fails, copies it. */
	async runInTerminal(command: string, what: string, config?: AgentConfig): Promise<void> {
		if (process.platform === "darwin") {
			try {
				const prefs = (config ?? (await this.agentConfig())).preferences;
				await openTerminal(prefs.terminal, command, prefs.terminal_command);
				return;
			} catch (e) {
				new Notice(`Atlas: cannot open the terminal (${(e as Error).message}). The Atlas settings choose it.`, 8000);
			}
		}
		await navigator.clipboard.writeText(command);
		new Notice(`Atlas: copied ${what}. Run it in a terminal.`);
	}

	/** Starts an agent in the vault, with the hand-off line of a thread or a chord as its first prompt. */
	async startAgent(type: "stub" | "chord", id: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return;
		const prompt = `Resume Atlas ${type === "chord" ? "chord" : "thread"} ${id}`;
		let config: AgentConfig;
		try {
			config = await this.agentConfig();
		} catch (e) {
			new Notice(`Atlas: cannot read the agent preferences: ${(e as Error).message}`, 8000);
			return;
		}
		await this.runInTerminal(startCommand(adapter.getBasePath(), config.preferences.agent_command, prompt), "the agent command", config);
	}

	/** The stub or chord open in the active view, or the chord of an open canvas. */
	activeWork(): { type: "stub" | "chord"; id: string; title: string } | null {
		const file = this.app.workspace.getActiveFile();
		if (!file) return null;
		if (file.extension === "canvas") {
			const chord = this.activeChord();
			return chord ? { type: "chord", ...chord } : null;
		}
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if ((fm?.type === "stub" || fm?.type === "chord") && fm.id) return { type: fm.type, id: String(fm.id), title: file.basename };
		return null;
	}

	/** The chord of the active note or canvas, or null. */
	activeChord(): { id: string; title: string } | null {
		const file = this.app.workspace.getActiveFile();
		if (!file) return null;
		const title = file.basename;
		// A chord's canvas is chords/<title>.canvas; its note holds the id.
		const note = file.extension === "canvas" ? this.app.metadataCache.getFirstLinkpathDest(title, "") : file;
		const fm = note ? this.app.metadataCache.getFileCache(note)?.frontmatter : undefined;
		if (fm?.type !== "chord" || !fm.id) return null;
		return { id: String(fm.id), title };
	}

	/** Asks for a new thread's title and idea, and plants it in a chord. */
	newThread(chord: { id: string; title: string }): void {
		new NewThreadModal(this.app, chord.title, async (title, idea) => {
			try {
				await this.atlas<unknown>(["thread", "stub", idea || title, "--title", title, "--chord", chord.id]);
				new Notice(`Atlas: planted ${title} in ${chord.title}.`);
			} catch (e) {
				new Notice(`Atlas: ${(e as Error).message}`, 8000);
			}
		}).open();
	}

	private async openSessions(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(SESSIONS_VIEW)[0];
		if (!leaf) {
			const right = workspace.getRightLeaf(false);
			if (!right) return;
			await right.setViewState({ type: SESSIONS_VIEW, active: true });
			leaf = right;
		}
		await workspace.revealLeaf(leaf);
	}
}

/** Shows the dry run of a migration, and runs it on a second click. */
class MigrationModal extends Modal {
	constructor(app: App, private report: MigrationReport, private run: () => Promise<void>) {
		super(app);
	}

	onOpen(): void {
		const r = this.report;
		this.setTitle("Migrate to the 8.0 layout");
		const el = this.contentEl;
		el.addClass("atlas-migration");
		if (r.from === "6.x") {
			el.createEl("p", { text: `The migration of ${r.vault} moves ${r.documents} documents into wiki/documents, writes ${r.events} events, and moves ${r.assets} files into wiki/assets. Then it makes each plan a thread: a stub, a spec, a task list, and a verification. It is one commit; git revert takes it back.` });
		} else {
			el.createEl("p", { text: `The migration of ${r.vault} makes each plan a thread, in one commit: ${r.threads ?? 0} threads, ${r.specs ?? 0} specs, ${r.task_lists ?? 0} task lists, ${r.verifications ?? 0} verifications, ${r.chords ?? 0} chords. Each plan keeps its id, its title, and its file, as the stub. ${r.notes ?? 0} notes keep the sections a spec does not hold. git revert takes it back.` });
		}
		const list = (title: string, rows: string[]) => {
			if (rows.length === 0) return;
			const d = el.createEl("details");
			d.createEl("summary", { text: `${title} (${rows.length})` });
			const ul = d.createEl("ul");
			for (const row of rows) ul.createEl("li", { text: row });
		};
		list("Tags from the scope tree", (r.tags ?? []).map((t) => `${t.scope} → #${t.tag}`));
		list("Titles that change; links follow", (r.retitles ?? []).map((t) => `${t.old} → ${t.new}`));
		list("Notes with no type, to the inbox", r.inbox ?? []);
		list("Files to the scratchpad", r.scratchpad ?? []);
		list("Warnings", r.warnings ?? []);
		const buttons = el.createDiv({ cls: "atlas-migration-buttons" });
		buttons.createEl("button", { text: "Cancel" }).onclick = () => this.close();
		const go = buttons.createEl("button", { text: "Migrate", cls: "mod-cta" });
		go.onclick = async () => {
			go.disabled = true;
			await this.run();
			this.close();
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
