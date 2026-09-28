import { App, PluginSettingTab, Setting } from "obsidian";
import { binaryVersion, findBinary } from "./cli";
import { GRAPH_MODES, GraphMode } from "./graphgroups";
import type AtlasPlugin from "./main";

export interface AtlasSettings {
	binaryPath: string;
	syncOnChange: boolean;
	badges: boolean;
	graphColors: GraphMode;
}

export const DEFAULT_SETTINGS: AtlasSettings = {
	binaryPath: "",
	syncOnChange: true,
	badges: true,
	graphColors: "area",
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
			.setName("Path to the atlas binary")
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
			.setName("Sync when a thread document changes")
			.setDesc("Runs atlas vault sync after you edit a file under threads/, so the board and the callouts follow.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncOnChange).onChange(async (value) => {
					this.plugin.settings.syncOnChange = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Badges in the file explorer")
			.setDesc("Shows the stage of each stub and the status of each session.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.badges).onChange(async (value) => {
					this.plugin.settings.badges = value;
					await this.plugin.saveSettings();
					this.plugin.badges.setEnabled(value);
				}),
			);

		new Setting(containerEl)
			.setName("Graph colors")
			.setDesc("Colors the nodes of the graph by area, by type, by the state of their threads, or by how recently they changed. The graph view has the same buttons.")
			.addDropdown((dropdown) => {
				for (const { mode, label } of GRAPH_MODES) dropdown.addOption(mode, label);
				dropdown
					.setValue(this.plugin.settings.graphColors)
					.onChange((value) => void this.plugin.graphColors.setMode(value as GraphMode));
			});
	}
}
