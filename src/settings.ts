import { App, Notice, PluginSettingTab, Setting, SettingDefinitionGroup, SettingDefinitionItem, TextComponent, debounce } from "obsidian";
import { binaryInfo, findBinary } from "./cli";
import { SNAPSHOT_QUIET_DEFAULT, binaryProblem, quietSeconds } from "./helpers";
import { AGENTS, AGENT_NAMES, Agent, AgentConfig, Preferences, TERMINALS, TERMINAL_NAMES, inherited, preference } from "./agents";
import type AlmagestPlugin from "./main";
import { homedir } from "os";

const shortHome = (p: string) => (p.startsWith(homedir() + "/") ? "~" + p.slice(homedir().length) : p);

export interface AlmagestSettings {
	binaryPath: string;
	syncOnChange: boolean;
	/** Seconds with no file event before the edits go into a snapshot commit; 0 turns it off. */
	snapshotQuietSeconds: number;
	/** Whether the file explorer colors wiki-view/, journals/, ingest/, and tool/. */
	colorFolders: boolean;
}

export const DEFAULT_SETTINGS: AlmagestSettings = {
	binaryPath: "",
	syncOnChange: true,
	snapshotQuietSeconds: SNAPSHOT_QUIET_DEFAULT,
	colorFolders: true,
};

/** An agent preference's control key: `agent:<global|vault>:<key>`, the key as almagest config names it. */
const preferenceKey = (allVaults: boolean, key: string) => `agent:${allVaults ? "global" : "vault"}:${key}`;

function parsePreferenceKey(control: string): { allVaults: boolean; key: string } | null {
	const m = /^agent:(global|vault):(.+)$/.exec(control);
	return m ? { allVaults: m[1] === "global", key: m[2]! } : null;
}

/**
 * The plugin's settings, as definitions, so Obsidian's settings search finds them. The
 * binary's status and the agent preferences come from the binary, so the tab reads them
 * when it opens and renders again when they arrive.
 */
export class AlmagestSettingTab extends PluginSettingTab {
	/** What the tab shows about the binary; "" until it is read. */
	private binaryStatus = "";
	/** The agent preferences, or why they could not be read. */
	private config: AgentConfig | null = null;
	private configError = "";
	/** Whether the binary's state was read since the tab last opened. */
	private loaded = false;
	private readonly recheckBinary = debounce(() => void this.load(), 500, true);

	constructor(
		app: App,
		private plugin: AlmagestPlugin,
	) {
		super(app, plugin);
	}

	hide(): void {
		this.loaded = false;
		super.hide();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		if (!this.loaded) {
			this.loaded = true;
			void this.load();
		}
		return [
			{
				name: "Path to the almagest binary",
				desc: "Leave empty to use ~/.almagest/bin/almagest, which the Almagest agent plugin installs.",
				control: { type: "text", key: "binaryPath", placeholder: findBinary("") ?? "Not found" },
			},
			{ name: "Binary", desc: this.binaryStatus || "Checking the binary…" },
			{
				name: "Keep the views fresh",
				desc: "Runs almagest vault sync --views two seconds after a note changes, so the views, the statuses, and the callouts follow your edits.",
				control: { type: "toggle", key: "syncOnChange" },
			},
			{
				name: "Snapshot after a quiet period",
				desc: "Seconds with no file change before Almagest commits your edits to the vault's history. 0 turns it off.",
				control: {
					type: "number",
					key: "snapshotQuietSeconds",
					min: 0,
					placeholder: String(DEFAULT_SETTINGS.snapshotQuietSeconds),
					validate: (seconds) => (Number.isFinite(seconds) && seconds >= 0 ? undefined : "Enter 0 or more seconds."),
				},
			},
			{
				name: "Color Almagest's folders",
				desc: "In the file explorer: what you read (wiki-view/) in cyan, what you write and add (journals/, ingest/) in purple, and what Almagest keeps for itself (tool/) dimmed.",
				control: { type: "toggle", key: "colorFolders" },
			},
			...this.agentGroups(),
		];
	}

	getControlValue(key: string): unknown {
		const pref = parsePreferenceKey(key);
		if (pref) return this.preferenceValue(pref.allVaults, pref.key);
		return this.plugin.settings[key as keyof AlmagestSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const pref = parsePreferenceKey(key);
		if (pref) return this.setPreference(pref.key, String(value), pref.allVaults);
		const { settings } = this.plugin;
		if (key === "binaryPath") {
			settings.binaryPath = String(value).trim();
			await this.plugin.saveSettings();
			this.recheckBinary();
		} else if (key === "syncOnChange") {
			settings.syncOnChange = Boolean(value);
			await this.plugin.saveSettings();
		} else if (key === "colorFolders") {
			settings.colorFolders = Boolean(value);
			await this.plugin.saveSettings();
			this.plugin.colorFolders();
		} else if (key === "snapshotQuietSeconds") {
			await this.plugin.setSnapshotQuiet(quietSeconds(value));
		}
	}

	/** Reads the binary's status and the agent preferences, then renders the tab again. */
	private async load(): Promise<void> {
		const bin = findBinary(this.plugin.settings.binaryPath);
		const info = await binaryInfo(bin);
		this.binaryStatus = binaryProblem(info, bin) || `Uses ${bin} (almagest ${info?.version}).`;
		try {
			this.config = await this.plugin.agentConfig();
			this.configError = "";
		} catch (e) {
			this.config = null;
			this.configError = `Almagest cannot read the agent preferences: ${(e as Error).message}`;
		}
		this.update();
	}

	private async setPreference(key: string, value: string, allVaults: boolean): Promise<void> {
		try {
			this.config = await this.plugin.setPreference(key, value, allVaults);
		} catch (e) {
			new Notice(`Almagest: ${(e as Error).message}`, 8000);
		}
		this.update();
	}

	private own(allVaults: boolean): Preferences | null {
		if (!this.config) return null;
		return allVaults ? this.config["global"] : this.config.vault;
	}

	/** A preference as its file sets it; the global file shows its defaults, a vault's file shows "" for "same as all vaults". */
	private preferenceValue(allVaults: boolean, key: string): string {
		const set = preference(this.own(allVaults), key);
		if (set || !allVaults) return set;
		if (key === "agent") return "claude";
		if (key === "terminal") return "terminal";
		return "";
	}

	/**
	 * The agent preferences: one group for every vault, one for this vault. A vault key
	 * left empty takes the global value, which its option and placeholder name.
	 */
	private agentGroups(): SettingDefinitionItem[] {
		const config = this.config;
		if (!config) {
			return [{ name: "Agents", desc: this.configError || "Reading the agent preferences…" }];
		}
		const intro = {
			name: "Agents",
			desc: `Start agent, Resume, and the palette's agents without Duet read these. ${shortHome(config.files["global"])} holds them for every vault; .almagest/config.json in this vault overrides them, key by key. almagest config shows the result.`,
		};
		return [intro, this.agentGroup(config, true), this.agentGroup(config, false)];
	}

	private agentGroup(config: AgentConfig, allVaults: boolean): SettingDefinitionGroup {
		const same = (label: string) => `Same as all vaults (${label})`;
		const agentOptions: Record<string, string> = allVaults ? {} : { "": same(AGENT_NAMES[inherited(config, "agent") as Agent] ?? inherited(config, "agent")) };
		for (const a of AGENTS) agentOptions[a] = AGENT_NAMES[a];
		const terminalOptions: Record<string, string> = allVaults ? {} : { "": same(TERMINAL_NAMES[inherited(config, "terminal") as keyof typeof TERMINAL_NAMES] ?? inherited(config, "terminal")) };
		for (const t of TERMINALS) terminalOptions[t] = TERMINAL_NAMES[t];
		const custom = () => (this.preferenceValue(allVaults, "terminal") || inherited(config, "terminal")) === "custom";
		return {
			type: "group",
			heading: allVaults ? "All vaults" : "This vault",
			items: [
				{ name: "Agent", control: { type: "dropdown", key: preferenceKey(allVaults, "agent"), options: agentOptions } },
				...AGENTS.map((a) => {
					const key = `agent_commands.${a}`;
					return {
						name: `${AGENT_NAMES[a]} command`,
						desc: allVaults ? `As typed in a shell: ${a}, or a shell function that picks an account.` : "Empty takes the value for all vaults.",
						render: (setting: Setting) => {
							setting.addText((t) => this.preferenceText(t, allVaults, key, allVaults ? a : inherited(config, key)));
						},
					};
				}),
				{
					name: "Terminal",
					desc: allVaults ? "Runs the command in your login shell, so your PATH and shell functions apply." : undefined,
					control: { type: "dropdown", key: preferenceKey(allVaults, "terminal"), options: terminalOptions },
				},
				{
					name: "Custom terminal command",
					desc: "Runs with /bin/sh. {command} stands for the agent's command, quoted. Example: kitty sh -lic {command}",
					visible: custom,
					render: (setting: Setting) => {
						setting.addText((t) => this.preferenceText(t, allVaults, "terminal_command", allVaults ? "" : inherited(config, "terminal_command")));
					},
				},
			],
		};
	}

	/** A text preference that the binary saves when the field loses focus, not at every key. */
	private preferenceText(text: TextComponent, allVaults: boolean, key: string, placeholder: string): void {
		text.setPlaceholder(placeholder).setValue(preference(this.own(allVaults), key));
		text.inputEl.addEventListener("change", () => void this.setPreference(key, text.getValue(), allVaults));
	}
}
