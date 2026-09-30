import { App, PluginSettingTab, Setting } from "obsidian";
import { binaryVersion, findBinary } from "./cli";
import { GRAPH_MODES, GraphMode } from "./graphgroups";
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
	/** The tags Focus mode crosses: the tag navigator's last choice. */
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
			.setName("Open a tag in the tag navigator")
			.setDesc("A click on a #tag in a note opens the tag navigator at that tag, in place of Obsidian's search.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.tagClick).onChange(async (value) => {
					this.plugin.settings.tagClick = value;
					await this.plugin.saveSettings();
				}),
			);

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
