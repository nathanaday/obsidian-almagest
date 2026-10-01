import { App, PluginSettingTab, Setting } from "obsidian";
import { binaryVersion, findBinary } from "./cli";
import { GRAPH_MODES, GraphMode } from "./graphgroups";
import { TERMINALS, TERMINAL_NAMES, TerminalApp } from "./agents";
import type AtlasPlugin from "./main";

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
	/** The terminal that Start agent and Resume open. */
	terminal: TerminalApp;
	/** The terminal command for the custom choice, with {command} for the agent's command. */
	terminalCommand: string;
	/** The command that starts the agent, as typed in a shell: claude, or a shell function. */
	agentCommand: string;
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
	terminal: "terminal",
	terminalCommand: "",
	agentCommand: "claude",
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
			.setDesc("Shows the status of each stub, plan, and session, and the kind of each event.")
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

		new Setting(containerEl)
			.setName("Agent command")
			.setDesc("What Start agent runs in the vault, with the hand-off line as its first prompt. Type it as you would in a shell: claude, or a shell function such as one that picks an account. This setting is per vault.")
			.addText((text) =>
				text
					.setPlaceholder("claude")
					.setValue(this.plugin.settings.agentCommand)
					.onChange(async (value) => {
						this.plugin.settings.agentCommand = value.trim() || "claude";
						await this.plugin.saveSettings();
					}),
			);

		let custom: Setting | null = null;
		new Setting(containerEl)
			.setName("Terminal")
			.setDesc("The terminal that Start agent and Resume open. It runs the command in your login shell, so your PATH and shell functions apply.")
			.addDropdown((dropdown) => {
				for (const t of TERMINALS) dropdown.addOption(t, TERMINAL_NAMES[t]);
				dropdown.setValue(this.plugin.settings.terminal).onChange(async (value) => {
					this.plugin.settings.terminal = value as TerminalApp;
					await this.plugin.saveSettings();
					custom?.settingEl.toggle(value === "custom");
				});
			});
		custom = new Setting(containerEl)
			.setName("Custom terminal command")
			.setDesc("Runs with /bin/sh. {command} stands for the agent's command, quoted. Example: kitty sh -lic {command}")
			.addText((text) =>
				text.setValue(this.plugin.settings.terminalCommand).onChange(async (value) => {
					this.plugin.settings.terminalCommand = value;
					await this.plugin.saveSettings();
				}),
			);
		custom.settingEl.toggle(this.plugin.settings.terminal === "custom");

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
}
