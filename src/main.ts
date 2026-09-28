import { FileSystemAdapter, Notice, Plugin, TFile, debounce } from "obsidian";
import { Badges } from "./badges";
import { ChangeBar } from "./changebar";
import { AtlasError, findBinary, runAtlas } from "./cli";
import { Synced, isThreadPath, syncSummary, syncedPaths, waitingLabel } from "./helpers";
import { mentionEditor, mentionReading } from "./mentions";
import { SESSIONS_VIEW, SessionsView, activeSessions } from "./sessions";
import { AtlasSettingTab, AtlasSettings, DEFAULT_SETTINGS } from "./settings";

const SYNC_DELAY = 1500;
// A change to a path the last sync wrote, this soon after it, is that sync's own write.
const ECHO_WINDOW = 5000;

export default class AtlasPlugin extends Plugin {
	settings: AtlasSettings = { ...DEFAULT_SETTINGS };
	badges!: Badges;

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

		this.addRibbonIcon("refresh-cw", "Atlas: sync the vault", () => void this.sync(true));
		this.addCommand({ id: "sync", name: "Sync the vault", callback: () => void this.sync(true) });

		this.registerView(SESSIONS_VIEW, (leaf) => new SessionsView(leaf));
		this.sessionsRibbon = this.addRibbonIcon("bot", "Atlas: open the sessions", () => void this.openSessions());
		this.sessionsRibbon.addClass("atlas-sessions-ribbon");
		this.addCommand({ id: "open-sessions", name: "Open the sessions", callback: () => void this.openSessions() });
		this.statusItem = this.addStatusBarItem();
		this.statusItem.addClass("atlas-status-waiting");
		this.statusItem.onClickEvent(() => void this.openSessions());

		this.registerEditorExtension(mentionEditor);
		this.registerMarkdownPostProcessor(mentionReading);

		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file.path.startsWith("sessions/")) this.refreshSessions();
				this.onThreadChange(file);
			}),
		);
		this.registerEvent(this.app.vault.on("delete", () => this.refreshSessions()));
		this.registerEvent(this.app.vault.on("rename", () => this.refreshSessions()));
		this.registerInterval(window.setInterval(() => this.sessionViews().forEach((v) => v.tick()), 30_000));
		this.app.workspace.onLayoutReady(() => this.refreshSessions());
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

	async loadSettings(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<AtlasSettings> | null) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
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
			const out = await this.atlas<{ synced: Synced }>(["vault", "sync"]);
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

	private onThreadChange(file: TFile): void {
		if (!this.settings.syncOnChange || !isThreadPath(file.path)) return;
		if (this.syncing) {
			this.pending.add(file.path);
			return;
		}
		if (Date.now() < this.echoUntil && this.echoes.has(file.path)) {
			this.echoes.delete(file.path);
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

	// Sessions

	private sessionViews(): SessionsView[] {
		return this.app.workspace
			.getLeavesOfType(SESSIONS_VIEW)
			.map((leaf) => leaf.view)
			.filter((v): v is SessionsView => v instanceof SessionsView);
	}

	private refreshSessions = debounce(
		() => {
			const waiting = activeSessions(this.app).filter((s) => s.status === "waiting").length;
			this.statusItem?.setText(waiting > 0 ? waitingLabel(waiting) : "");
			this.statusItem?.toggleClass("is-hidden", waiting === 0);
			if (this.sessionsRibbon) {
				if (waiting > 0) this.sessionsRibbon.dataset.atlasCount = String(waiting);
				else delete this.sessionsRibbon.dataset.atlasCount;
			}
			this.sessionViews().forEach((v) => v.render());
		},
		500,
		true,
	);

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
