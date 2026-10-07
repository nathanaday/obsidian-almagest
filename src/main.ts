import { FileSystemAdapter, MarkdownView, Notice, Plugin, TAbstractFile, TFile } from "obsidian";
import { ChangeRunner, changeProcessor } from "./change";
import { AlmagestError, binaryInfo, findBinary, runAlmagest } from "./cli";
import {
	LAYOUT,
	VAULT_DOCUMENT,
	layoutNeeds,
	binaryProblem,
	Synced,
	isLockHeld,
	isSnapshotPath,
	isWatchedPath,
	layoutOf,
	quietSeconds,
	strayNotices,
	syncSummary,
	syncedPaths,
} from "./helpers";
import { QuietTimer } from "./quiet";
import { repoProcessor } from "./repo";
import { AgentConfig, duetTipCommand, recommendDuet, startCommand } from "./agents";
import { Conversations, duetApi, duetState } from "./conversations";
import { tipExtension, tipPostProcessor } from "./duettip";
import { openTerminal } from "./launcher";
import { volumeOf } from "./journalstate";
import { PALETTE_ICON, PALETTE_VIEW, PaletteView } from "./palette";
import { confirmPublishOf } from "./publish";
import { AlmagestSettingTab, AlmagestSettings, DEFAULT_SETTINGS } from "./settings";
import { isWikified } from "./marks";

/** Runs another plugin's command by its id; false when no plugin gives it. */
function executeCommand(app: unknown, id: string): boolean {
	const commands = (app as { commands?: { executeCommandById?(id: string): boolean } }).commands;
	return commands?.executeCommandById?.(id) === true;
}

/** The class on the body that colors Almagest's folders in the file explorer (styles.css). */
const FOLDER_COLORS = "almagest-folder-colors";
import { Wikify, markExtension, markPostProcessor } from "./wikify";

const SYNC_DELAY = 2000;
// A change to a path the last sync wrote, this soon after it, is that sync's own write.
const ECHO_WINDOW = 5000;
/** How long to wait for Obsidian to see a document the binary wrote. */
const SEE_MS = 10_000;

export default class AlmagestPlugin extends Plugin {
	settings: AlmagestSettings = { ...DEFAULT_SETTINGS };

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


	/** The journal volume that a publish captures now, or "". */
	publishing = "";

	/** The bubbles of wikified notes, and Create. */
	readonly wikify = new Wikify(this);

	/** The agents the palette started through Duet, while their turn runs. */
	readonly conversations = new Conversations(
		() => this.paletteViews().forEach((v) => v.draw()),
		(c, turn) => {
			if (turn.status === "failed") new Notice(`Almagest: the ${c.label} agent stopped: ${turn.error ?? "its turn failed"}.`, 10_000);
		},
	);

	private layoutNotice: Notice | null = null;
	private settingTab: AlmagestSettingTab | null = null;
	/** The choice of host and Duet's state, as the tip and the settings last showed them. */
	private duetKey = "";
	private readonly duetListeners = new Set<() => void>();
	/** The layout the notice and the palettes last followed; null before the first read. */
	private knownLayout: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.settingTab = new AlmagestSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.registerMarkdownCodeBlockProcessor("almagest-repo", repoProcessor(this));
		this.registerMarkdownCodeBlockProcessor("almagest-change", changeProcessor(this, new ChangeRunner(this)));

		this.registerEditorExtension(markExtension(this.wikify));
		this.registerMarkdownPostProcessor(markPostProcessor(this, this.wikify));
		const tip = { show: () => this.recommendDuet(), listen: (fn: () => void) => this.onDuetChange(fn) };
		this.registerEditorExtension(tipExtension(tip));
		this.registerMarkdownPostProcessor(tipPostProcessor(tip));
		// Obsidian sends no event when a plugin turns on or off, so Duet's state is read every two seconds.
		this.registerInterval(window.setInterval(() => this.checkDuet(), 2000));
		this.wikify.register();
		this.addCommand({
			id: "accept-link-marks",
			name: "Accept every link mark in this note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !isWikified(file.path)) return false;
				if (!checking) void this.wikify.acceptAll(file);
				return true;
			},
		});

		this.addCommand({ id: "sync", name: "Sync the vault", callback: () => void this.sync(true) });


		this.registerView(PALETTE_VIEW, (leaf) => new PaletteView(leaf, this));
		this.addRibbonIcon(PALETTE_ICON, "Almagest", () => void this.openPalette());
		this.addCommand({ id: "open-palette", name: "Open the tool palette", callback: () => void this.openPalette() });

		this.addCommand({ id: "start-agent", name: "Start agent", callback: () => void this.startAgent() });
		this.addCommand({
			id: "publish-journal",
			name: "Publish this journal volume",
			checkCallback: (checking) => {
				const volume = volumeOf(this.app.workspace.getActiveFile()?.path ?? "");
				if (!volume) return false;
				if (!checking) void confirmPublishOf(this, volume);
				return true;
			},
		});

		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file.path === VAULT_DOCUMENT) this.onLayoutChange();
				this.onDocChange(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.onDocChange(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.onDocChange(file.path);
				this.onDocChange(oldPath);
			}),
		);
		this.colorFolders();
		this.app.workspace.onLayoutReady(() => {
			void this.checkBinary();
			this.onLayoutChange();
			this.watchForSnapshots();
		});
	}

	onunload(): void {
		document.body.removeClass(FOLDER_COLORS);
		this.layoutNotice?.hide();
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
		this.snapshots.stop();
		this.conversations.stop();
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<AlmagestSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS };
		// Only the keys this version knows; any other key goes at the next save.
		for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AlmagestSettings)[]) {
			if (saved && saved[key] !== undefined) (this.settings as unknown as Record<string, unknown>)[key] = saved[key];
		}
		this.settings.snapshotQuietSeconds = quietSeconds(this.settings.snapshotQuietSeconds);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Runs one almagest command in this vault and returns its JSON; answers are the exit codes that print an answer too. */
	almagest<T>(args: string[], answers: number[] = []): Promise<T> {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			return Promise.reject(new AlmagestError("this vault is not a folder on disk"));
		}
		return runAlmagest<T>(findBinary(this.settings.binaryPath), adapter.getBasePath(), args, answers);
	}

	// Sync

	/** A manual sync runs every step; an automatic one runs the steps that read no git. */
	async sync(manual: boolean): Promise<void> {
		if (this.syncing) {
			if (manual) new Notice("Almagest: a sync is running.");
			return;
		}
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
		this.syncTimer = null;
		this.syncing = true;
		this.pending.clear();
		let wrote: string[] = [];
		try {
			const args = manual ? ["vault", "sync"] : ["vault", "sync", "--views"];
			const out = await this.almagest<{ synced: Synced }>(args);
			wrote = syncedPaths(out.synced);
			this.lastAutoError = "";
			if (manual) new Notice(`Almagest: ${syncSummary(out.synced)}`);
			for (const line of strayNotices(out.synced)) new Notice(`Almagest: ${line}`, 0);
		} catch (e) {
			const message = (e as Error).message;
			// A background sync that fails the same way again stays quiet.
			if (manual || message !== this.lastAutoError) new Notice(`Almagest: ${message}`);
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
		if (!this.settings.syncOnChange || !isWatchedPath(path) || !this.ready()) return;
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
		if (!this.ready()) return false;
		try {
			await this.almagest<unknown>(["vault", "snapshot"]);
			this.lastSnapshotError = "";
			return false;
		} catch (e) {
			const message = (e as Error).message;
			if (isLockHeld(message)) return true;
			if (message !== this.lastSnapshotError) console.warn(`Almagest: the snapshot failed: ${message}`);
			this.lastSnapshotError = message;
			return false;
		}
	}

	// Layout

	/** The layout the vault document records; this plugin's when there is no vault document. */
	private layout(): number {
		const file = this.app.vault.getFileByPath(VAULT_DOCUMENT);
		if (!file) return LAYOUT;
		return layoutOf(this.app.metadataCache.getFileCache(file)?.frontmatter);
	}

	/** Whether the vault has the layout this plugin reads. */
	ready(): boolean {
		return this.layout() === LAYOUT;
	}

	/** What the vault needs before the plugin works in it: its migration, an update, or nothing. */
	needs(): "migrate" | "update" | "" {
		return layoutNeeds(this.layout());
	}

	/** Says once, until the user closes it, what keeps the plugin from its binary. */
	private async checkBinary(): Promise<void> {
		const found = findBinary(this.settings.binaryPath);
		const problem = binaryProblem(await binaryInfo(found), found);
		if (problem) new Notice(`Almagest: ${problem}`, 0);
	}

	/** Says, until the layout changes or the user closes it, what a vault of another layout needs. */
	private checkLayout(): void {
		this.layoutNotice?.hide();
		this.layoutNotice = null;
		const needs = this.needs();
		if (needs === "migrate") {
			this.layoutNotice = new Notice("Almagest: this vault keeps sessions/, source-core/, and trash/ at its root, and this version keeps them in tool/. Open the Almagest palette to migrate the vault.", 0);
		} else if (needs === "update") {
			this.layoutNotice = new Notice(
				`Almagest: this vault has layout ${this.layout()}, and this plugin reads layout ${LAYOUT}. Update Almagest in Obsidian's community plugins, and the agent plugin (claude plugin update almagest@nathanaday-almagest).`,
				0,
			);
		}
	}

	/**
	 * Follows the layout the vault document records, at the start and after a migration
	 * here or in a terminal: the notice and the palettes follow it once per change.
	 */
	private onLayoutChange(): void {
		const file = this.app.vault.getFileByPath(VAULT_DOCUMENT);
		// Obsidian has not read the vault document yet; its "changed" event follows.
		if (file && !this.app.metadataCache.getFileCache(file)) return;
		const layout = this.layout();
		if (layout === this.knownLayout) return;
		this.knownLayout = layout;
		this.checkLayout();
		this.paletteViews().forEach((v) => void v.refresh());
	}

	/** Colors the folders of Almagest in the file explorer, while the setting is on. */
	colorFolders(): void {
		document.body.toggleClass(FOLDER_COLORS, this.settings.colorFolders);
	}

	// Views

	async openPalette(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(PALETTE_VIEW)[0];
		if (!leaf) {
			const right = workspace.getRightLeaf(false);
			if (!right) return;
			await right.setViewState({ type: PALETTE_VIEW, active: true });
			leaf = right;
		}
		await workspace.revealLeaf(leaf);
	}

	/** Marks the volume a publish captures, "" when it ends, in every palette. */
	setPublishing(volume: string): void {
		this.publishing = volume;
		for (const view of this.paletteViews()) {
			view.draw();
			if (!volume) void view.refresh();
		}
	}

	/** Opens a file once Obsidian sees it; a document the binary just wrote takes a moment. */
	async openWhenSeen(path: string, newTab: boolean): Promise<void> {
		const deadline = Date.now() + SEE_MS;
		let file = this.app.vault.getFileByPath(path);
		while (!file && Date.now() < deadline) {
			await new Promise((resolve) => window.setTimeout(resolve, 100));
			file = this.app.vault.getFileByPath(path);
		}
		if (!(file instanceof TFile)) {
			new Notice(`Almagest: Obsidian does not see ${path} yet.`);
			return;
		}
		await this.app.workspace.getLeaf(newTab ? "tab" : false).openFile(file);
	}

	private paletteViews(): PaletteView[] {
		return this.app.workspace
			.getLeavesOfType(PALETTE_VIEW)
			.map((leaf) => leaf.view)
			.filter((v): v is PaletteView => v instanceof PaletteView);
	}

	/** How long a session with no recorded process may go quiet before it counts as gone. */
	staleHours(): number {
		const file = this.app.vault.getFileByPath(VAULT_DOCUMENT);
		const n = Number(file ? this.app.metadataCache.getFileCache(file)?.frontmatter?.stale_hours : 0);
		return n > 0 ? n : 12;
	}

	// Agents

	/** The agent preferences: the vault's config file over ~/.almagest/config.json. */
	agentConfig(): Promise<AgentConfig> {
		return this.almagest<AgentConfig>(["config"]);
	}

	/** Sets or unsets (value "") one agent preference, in the vault's file or the global one. */
	async setPreference(key: string, value: string, global: boolean): Promise<AgentConfig> {
		const args = value ? ["config", "set", key, value] : ["config", "unset", key];
		return this.almagest<AgentConfig>(global ? [...args, "--global"] : args);
	}

	/** Runs a command in a new terminal; off macOS, or when that fails, copies it. */
	async runInTerminal(command: string, what: string, config?: AgentConfig): Promise<void> {
		if (process.platform === "darwin") {
			try {
				const prefs = (config ?? (await this.agentConfig())).preferences;
				await openTerminal(prefs.terminal, command, prefs.terminal_command);
				return;
			} catch (e) {
				new Notice(`Almagest: cannot open the terminal (${(e as Error).message}). The Almagest settings choose it.`, 8000);
			}
		}
		await navigator.clipboard.writeText(command);
		new Notice(`Almagest: copied ${what}. Run it in a terminal.`);
	}

	// Where agents work: Duet when the settings choose it and it runs, else a terminal.

	/** Duet's API when the settings choose Duet and it runs. */
	private duet() {
		return this.settings.conversations === "duet" ? duetApi(this.app) : undefined;
	}

	/** Whether to recommend Duet, in Almagest.md and in a new terminal. */
	recommendDuet(): boolean {
		return recommendDuet(this.settings.conversations, duetState(this.app));
	}

	/** Calls fn after the choice of host or Duet's state changes; returns a function that stops the calls. */
	onDuetChange(fn: () => void): () => void {
		this.duetListeners.add(fn);
		return () => this.duetListeners.delete(fn);
	}

	private checkDuet(): void {
		const key = `${this.settings.conversations} ${duetState(this.app)}`;
		if (key === this.duetKey) return;
		this.duetKey = key;
		this.duetChanged();
	}

	/** Draws again what depends on Duet: the tip in Almagest.md, in both modes, and the settings. */
	duetChanged(): void {
		this.duetKey = `${this.settings.conversations} ${duetState(this.app)}`;
		this.duetListeners.forEach((fn) => fn());
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView && leaf.view.file?.path === VAULT_DOCUMENT) leaf.view.previewMode.rerender(true);
		}
		if (this.settingTab?.containerEl.isShown()) this.settingTab.update();
	}

	/** Starts an agent in the vault: an empty Duet conversation, or the agent in a terminal with prompt as its first message. */
	async startAgent(prompt = ""): Promise<void> {
		if (!prompt && this.duet() && executeCommand(this.app, "duet:new-chat")) return;
		await this.startInTerminal(prompt);
	}

	/** Starts the agent in a new terminal; while Duet is the choice and does not run, the terminal shows the tip first. */
	private async startInTerminal(prompt: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return;
		let config: AgentConfig;
		try {
			config = await this.agentConfig();
		} catch (e) {
			new Notice(`Almagest: cannot read the agent preferences: ${(e as Error).message}`, 8000);
			return;
		}
		const command = startCommand(adapter.getBasePath(), config.preferences.agent_command, prompt);
		await this.runInTerminal(this.recommendDuet() ? `${duetTipCommand()} && ${command}` : command, "the agent command", config);
	}

	/**
	 * Starts an agent with a first message: in a Duet conversation, which the palette lists
	 * while its turn runs, else in a terminal. title names the conversation note; label says
	 * what the agent does.
	 */
	async runAgent(message: string, title: string, label: string): Promise<void> {
		const api = this.duet();
		if (api) {
			try {
				const { path } = await api.newConversation({ message, title, loadUserSetup: true });
				this.conversations.follow(api, path, label);
				return;
			} catch (e) {
				new Notice(`Almagest: Duet did not start the agent (${(e as Error).message}). Almagest starts it in a terminal.`, 10_000);
			}
		} else if (this.settings.conversations === "duet") {
			new Notice("Almagest: Duet is not on, so the agent starts in a terminal. The Almagest settings say what Duet needs, or choose the terminal there.", 10_000);
		}
		await this.startInTerminal(message);
	}

	/** Drops the conversations whose turn ended while no event came, such as when Duet turned off. */
	checkConversations(): void {
		this.conversations.check(duetApi(this.app));
	}
}
