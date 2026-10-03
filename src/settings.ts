import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { binaryVersion, findBinary } from "./cli";
import { GRAPH_MODES, GraphMode } from "./graphgroups";
import { AGENTS, AGENT_NAMES, AgentConfig, TERMINALS, TERMINAL_NAMES, inherited, preference } from "./agents";
import type AtlasPlugin from "./main";
import { homedir } from "os";

const shortHome = (p: string) => (p.startsWith(homedir() + "/") ? "~" + p.slice(homedir().length) : p);

export interface AtlasSettings {
	binaryPath: string;
	syncOnChange: boolean;
	badges: boolean;
	viewFolders: boolean;
	tagClick: boolean;
	graphColors: GraphMode;
	/** The graph queries Atlas wrote last, so it replaces only its own groups. */
	graphOwned: string[];
	/** The tags Focus mode crosses: the Atlas navigator's last choice. */
	focusTags: string[];
}

export const DEFAULT_SETTINGS: AtlasSettings = {
	binaryPath: "",
	syncOnChange: true,
	badges: true,
	viewFolders: true,
	tagClick: false,
	graphColors: "tag",
	graphOwned: [],
	focusTags: [],
};

export class AtlasSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: AtlasPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const found = findBinary("");

		const binary = new Setting(containerEl)
			.setName("Path to the atlas-obsidian binary")
			.setDesc("Leave empty to use the binary Atlas finds.")
			.addText((text) =>
				text
					.setPlaceholder(found ?? "Not found")
					.setValue(this.plugin.settings.binaryPath)
					.onChange(async (value) => {
						this.plugin.settings.binaryPath = value.trim();
						await this.plugin.saveSettings();
						void showVersion();
					}),
			);
		const status = binary.descEl.createDiv({ cls: "atlas-setting-status" });
		const showVersion = async () => {
			const bin = findBinary(this.plugin.settings.binaryPath);
			if (!bin) {
				status.setText("No binary found.");
				return;
			}
			try {
				status.setText(`Uses ${bin} (${await binaryVersion(bin)}).`);
			} catch (e) {
				status.setText(`Cannot run ${bin}: ${(e as Error).message}`);
			}
		};
		void showVersion();

		new Setting(containerEl)
			.setName("Keep the views fresh")
			.setDesc("Runs atlas-obsidian vault sync --views two seconds after a note changes, so the views, the statuses, and the callouts follow your edits.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncOnChange).onChange(async (value) => {
					this.plugin.settings.syncOnChange = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Badges in the file explorer")
			.setDesc("Shows the status of each thread, chord, and session, and the kind of each event.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.badges).onChange(async (value) => {
					this.plugin.settings.badges = value;
					await this.plugin.saveSettings();
					this.plugin.badges.setEnabled(value);
				}),
			);

		new Setting(containerEl)
			.setName("Open a tag's view from its folder")
			.setDesc("In the file explorer, a click on a folder under views/tags opens the tag's view, and the view itself is hidden inside the folder.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.viewFolders).onChange(async (value) => {
					this.plugin.settings.viewFolders = value;
					await this.plugin.saveSettings();
					this.plugin.viewFolders.setEnabled(value);
				}),
			);

		new Setting(containerEl)
			.setName("Open a tag in the Atlas navigator")
			.setDesc("A click on a #tag in a note opens the Atlas navigator at that tag, in place of Obsidian's search.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.tagClick).onChange(async (value) => {
					this.plugin.settings.tagClick = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("Agents").setHeading();
		const agents = containerEl.createDiv();
		void this.agents(agents);

		new Setting(containerEl).setName("Graph").setHeading();

		new Setting(containerEl)
			.setName("Graph colors")
			.setDesc("Colors the nodes of the graph by top tag, by type, by the state of their work, or by how recently they changed. The graph view has the same buttons.")
			.addDropdown((dropdown) => {
				for (const { mode, label } of GRAPH_MODES) dropdown.addOption(mode, label);
				dropdown
					.setValue(this.plugin.settings.graphColors)
					.onChange((value) => void this.plugin.graphColors.setMode(value as GraphMode));
			});
	}

	/**
	 * The agent preferences, from the binary: one group for every vault, one for this vault.
	 * A vault key left empty takes the global value, shown as its placeholder.
	 */
	private async agents(el: HTMLElement): Promise<void> {
		let config: AgentConfig;
		try {
			config = await this.plugin.agentConfig();
		} catch (e) {
			el.empty();
			el.createDiv({ cls: "setting-item-description", text: `Atlas cannot read the agent preferences: ${(e as Error).message}` });
			return;
		}
		el.empty();
		const intro = el.createDiv({ cls: "setting-item-description atlas-setting-intro" });
		intro.setText(`Start agent and Resume read these. ${shortHome(config.files.global)} holds them for every vault; .atlas/config.json in this vault overrides them, key by key. atlas-obsidian config shows the result.`);

		const set = async (key: string, value: string, global: boolean) => {
			try {
				await this.plugin.setPreference(key, value, global);
			} catch (e) {
				new Notice(`Atlas: ${(e as Error).message}`, 8000);
			}
			void this.agents(el);
		};
		const group = (name: string, global: boolean) => {
			new Setting(el).setName(name).setHeading();
			const own = global ? config.global : config.vault;
			const same = (key: string, label: string) => (global ? "" : `Same as all vaults (${label || inherited(config, key)})`);

			new Setting(el).setName("Agent").addDropdown((d) => {
				if (!global) d.addOption("", same("agent", AGENT_NAMES[inherited(config, "agent") as keyof typeof AGENT_NAMES]));
				for (const a of AGENTS) d.addOption(a, AGENT_NAMES[a]);
				d.setValue(preference(own, "agent") || (global ? "claude" : "")).onChange((v) => void set("agent", v, global));
			});
			for (const a of AGENTS) {
				const key = `agent_commands.${a}`;
				new Setting(el)
					.setName(`${AGENT_NAMES[a]} command`)
					.setDesc(global ? `As typed in a shell: ${a}, or a shell function that picks an account.` : "Empty takes the value for all vaults.")
					.addText((t) => {
						t.setPlaceholder(global ? a : inherited(config, key)).setValue(preference(own, key));
						t.inputEl.addEventListener("change", () => void set(key, t.getValue(), global));
					});
			}
			new Setting(el)
				.setName("Terminal")
				.setDesc(global ? "Runs the command in your login shell, so your PATH and shell functions apply." : "")
				.addDropdown((d) => {
					if (!global) d.addOption("", same("terminal", TERMINAL_NAMES[inherited(config, "terminal") as keyof typeof TERMINAL_NAMES]));
					for (const t of TERMINALS) d.addOption(t, TERMINAL_NAMES[t]);
					d.setValue(preference(own, "terminal") || (global ? "terminal" : "")).onChange((v) => void set("terminal", v, global));
				});
			const terminal = preference(own, "terminal") || inherited(config, "terminal");
			if (terminal === "custom") {
				new Setting(el)
					.setName("Custom terminal command")
					.setDesc("Runs with /bin/sh. {command} stands for the agent's command, quoted. Example: kitty sh -lic {command}")
					.addText((t) => {
						t.setPlaceholder(global ? "" : inherited(config, "terminal_command")).setValue(preference(own, "terminal_command"));
						t.inputEl.addEventListener("change", () => void set("terminal_command", t.getValue(), global));
					});
			}
		};
		group("All vaults", true);
		group("This vault", false);
	}
}
