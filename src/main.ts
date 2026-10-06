import { App, FileSystemAdapter, Modal, Notice, Plugin, TAbstractFile, debounce } from "obsidian";
import { ChangeRunner, changeProcessor } from "./change";
import { AtlasError, findBinary, runAtlas } from "./cli";
import {
	LAYOUT,
	MIGRATES_FROM,
	MigrationReport,
	Synced,
	isLockHeld,
	isSnapshotPath,
	isWatchedPath,
	layoutName,
	layoutOf,
	migrationSteps,
	migrationSummary,
	normalTag,
	quietSeconds,
	strayNotices,
	syncSummary,
	syncedPaths,
	waitingLabel,
} from "./helpers";
import { QuietTimer } from "./quiet";
import { repoProcessor } from "./repo";
import { SESSIONS_VIEW, SessionsView, sessionGroups } from "./sessions";
import { AgentConfig, legacyPreferences, startCommand } from "./agents";
import { openTerminal } from "./launcher";
import { AtlasSettingTab, AtlasSettings, DEFAULT_SETTINGS } from "./settings";
import { NAV_ICON, TAG_NAV_VIEW, TagNavigator } from "./tagnav";

const SYNC_DELAY = 2000;
const LEGACY_KEYS = ["agentCommand", "terminal", "terminalCommand"];
// A change to a path the last sync wrote, this soon after it, is that sync's own write.
const ECHO_WINDOW = 5000;

export default class AtlasPlugin extends Plugin {
	settings: AtlasSettings = { ...DEFAULT_SETTINGS };
	/** The agent settings of 8.0.2, kept in data.json until they move to the vault's config file. */
	private legacy: Record<string, unknown> | null = null;

	private syncing = false;
	private syncTimer: number | null = null;
	private pending = new Set<string>();
	private echoes = new Set<string>();
	private echoUntil = 0;
	private lastAutoError = "";

	/** Commits the user's edits after a quiet period. */
	private snapshots = new QuietTimer(
		{ set: (fn, ms) => window.setTimeout(fn, ms), clear: (h) => window.clearTimeout(h) },
		() => this.snapshot(),
		0,
	);
	private lastSnapshotError = "";

	private sessionsRibbon: HTMLElement | null = null;
	private statusItem: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new AtlasSettingTab(this.app, this));

		this.registerMarkdownCodeBlockProcessor("atlas-repo", repoProcessor(this));
		this.registerMarkdownCodeBlockProcessor("atlas-change", changeProcessor(this, new ChangeRunner(this)));

		this.addRibbonIcon("refresh-cw", "Atlas: sync the vault", () => void this.sync(true));
		this.addCommand({ id: "sync", name: "Sync the vault", callback: () => void this.sync(true) });

		this.registerView(TAG_NAV_VIEW, (leaf) => new TagNavigator(leaf));
		this.addRibbonIcon(NAV_ICON, "Atlas: open the Atlas navigator", () => void this.openTags());
		this.addCommand({ id: "open-tags", name: "Open the Atlas navigator", callback: () => void this.openTags() });
		// A click on a #tag opens the navigator at it, when the setting asks.
		this.registerDomEvent(document, "click", (evt) => this.onTagClick(evt), { capture: true });

		this.addCommand({ id: "start-agent", name: "Start agent", callback: () => void this.startAgent() });

		this.registerView(SESSIONS_VIEW, (leaf) => new SessionsView(leaf, this));
		this.sessionsRibbon = this.addRibbonIcon("bot", "Atlas: open the sessions", () => void this.openSessions());
		this.sessionsRibbon.addClass("atlas-sessions-ribbon");
		this.addCommand({ id: "open-sessions", name: "Open the sessions", callback: () => void this.openSessions() });
		this.statusItem = this.addStatusBarItem();
		this.statusItem.addClass("atlas-status-waiting");
		this.statusItem.onClickEvent(() => void this.openSessions());

		this.addCommand({ id: "migrate", name: `Migrate this vault to the ${layoutName(LAYOUT)} layout`, callback: () => void this.migrate() });

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
			this.watchForSnapshots();
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
		this.snapshots.stop();
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<AtlasSettings> | null;
		const old = Object.entries(saved ?? {}).filter(([k]) => LEGACY_KEYS.includes(k));
		this.legacy = old.length > 0 ? Object.fromEntries(old) : null;
		this.settings = { ...DEFAULT_SETTINGS };
		// Only the keys this version knows; an older version's key goes at the next save.
		for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AtlasSettings)[]) {
			if (saved && saved[key] !== undefined) (this.settings as unknown as Record<string, unknown>)[key] = saved[key];
		}
		this.settings.snapshotQuietSeconds = quietSeconds(this.settings.snapshotQuietSeconds);
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

	/** A manual sync runs every step; an automatic one runs the steps that read no git. */
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
			for (const line of strayNotices(out.synced)) new Notice(`Atlas: ${line}`, 0);
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

	// Quiet snapshots

	/** Counts file events from now on: the events of Obsidian's first load are not edits. */
	private watchForSnapshots(): void {
		const touch = (...paths: string[]) => {
			if (paths.some((p) => isSnapshotPath(p, this.app.vault.configDir))) this.snapshots.touch();
		};
		this.registerEvent(this.app.vault.on("create", (f: TAbstractFile) => touch(f.path)));
		this.registerEvent(this.app.vault.on("modify", (f: TAbstractFile) => touch(f.path)));
		this.registerEvent(this.app.vault.on("delete", (f: TAbstractFile) => touch(f.path)));
		this.registerEvent(this.app.vault.on("rename", (f: TAbstractFile, oldPath: string) => touch(f.path, oldPath)));
		this.snapshots.setQuiet(this.settings.snapshotQuietSeconds * 1000);
		// Edits saved while Obsidian was closed go into the first snapshot.
		this.snapshots.touch();
	}

	async setSnapshotQuiet(seconds: number): Promise<void> {
		this.settings.snapshotQuietSeconds = seconds;
		await this.saveSettings();
		if (this.app.workspace.layoutReady) this.snapshots.setQuiet(seconds * 1000);
	}

	/**
	 * Commits the hand edits as one snapshot. It shows no notice: a held lock tries again
	 * after the next quiet period, and any other failure waits for the next edit.
	 */
	private async snapshot(): Promise<boolean> {
		if (!this.migrated()) return false;
		try {
			await this.atlas<unknown>(["vault", "snapshot"]);
			this.lastSnapshotError = "";
			return false;
		} catch (e) {
			const message = (e as Error).message;
			if (isLockHeld(message)) return true;
			if (message !== this.lastSnapshotError) console.warn(`Atlas: the snapshot failed: ${message}`);
			this.lastSnapshotError = message;
			return false;
		}
	}

	// Layout

	/** The layout the vault document records; this plugin's when there is none to read. */
	private layout(): number {
		const atlas = this.app.vault.getFileByPath("Atlas.md");
		if (!atlas) return LAYOUT;
		return layoutOf(this.app.metadataCache.getFileCache(atlas)?.frontmatter);
	}

	/** Whether the vault has the layout this plugin reads. */
	private migrated(): boolean {
		return this.layout() >= LAYOUT;
	}

	private checkLayout(): void {
		if (this.migrated()) return;
		const notice = new Notice("", 0);
		const el = notice.messageEl;
		const layout = this.layout();
		const needs = `Atlas: this vault has the ${layoutName(layout)} layout. This plugin needs the ${layoutName(LAYOUT)} layout.`;
		if (layout < MIGRATES_FROM) {
			el.createDiv({ text: `${needs} Migrate the vault to 8.x with Atlas 8.1.1 first.` });
			return;
		}
		el.createDiv({ text: needs });
		const button = el.createEl("button", { text: "Show the migration", cls: "mod-cta atlas-notice-button" });
		button.onclick = () => {
			notice.hide();
			void this.migrate();
		};
	}

	private async migrate(): Promise<void> {
		try {
			const report = await this.atlas<MigrationReport>(["vault", "migrate", "--dry-run"]);
			new MigrationModal(this.app, report, this.layout(), async () => {
				try {
					const done = await this.atlas<MigrationReport>(["vault", "migrate"]);
					new Notice(`Atlas: ${migrationSummary(done)}`, 10_000);
					for (const line of strayNotices(done)) new Notice(`Atlas: ${line}`, 0);
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

	/** Moves the agent settings of 8.0.2 into the vault's config file, once. */
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

	/** Starts the agent in the vault. */
	private async startAgent(): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return;
		let config: AgentConfig;
		try {
			config = await this.agentConfig();
		} catch (e) {
			new Notice(`Atlas: cannot read the agent preferences: ${(e as Error).message}`, 8000);
			return;
		}
		await this.runInTerminal(startCommand(adapter.getBasePath(), config.preferences.agent_command), "the agent command", config);
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
	constructor(
		app: App,
		private report: MigrationReport,
		private layout: number,
		private run: () => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const r = this.report;
		const from = r.from || layoutName(this.layout);
		this.setTitle(`Migrate to the ${layoutName(LAYOUT)} layout`);
		const el = this.contentEl;
		el.addClass("atlas-migration");
		el.createEl("p", { text: `The migration moves ${r.vault} from the ${from} layout to the ${layoutName(LAYOUT)} layout in one commit. git revert takes it back. It:` });
		const steps = el.createEl("ul");
		for (const step of migrationSteps(this.layout)) steps.createEl("li", { text: step });

		const list = <T>(items: T[] | null | undefined, title: string, line: (item: T) => string) => {
			if (!items || items.length === 0) return;
			const d = el.createEl("details");
			d.createEl("summary", { text: `${title} (${items.length})` });
			const ul = d.createEl("ul");
			for (const item of items) ul.createEl("li", { text: line(item) });
		};
		const move = (m: { from: string; to: string }) => `${m.from} → ${m.to}`;
		list(r.moved, "Files to move", move);
		list(r.edited, "Files to edit", (p) => p);
		list(r.strays, "Your notes in views/, to move to ingest/", move);
		list(r.warnings, "Warnings", (w) => w);

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
