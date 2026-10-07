import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { binaryVersion, findBinary } from "./cli";
import { SNAPSHOT_QUIET_DEFAULT, quietSeconds } from "./helpers";
import { AGENTS, AGENT_NAMES, AgentConfig, TERMINALS, TERMINAL_NAMES, inherited, preference } from "./agents";
import type AtlasPlugin from "./main";
import { homedir } from "os";

const shortHome = (p: string) => (p.startsWith(homedir() + "/") ? "~" + p.slice(homedir().length) : p);

export interface AtlasSettings {
	binaryPath: string;
	syncOnChange: boolean;
	/** Seconds with no file event before the edits go into a snapshot commit; 0 turns it off. */
	snapshotQuietSeconds: number;
}

export const DEFAULT_SETTINGS: AtlasSettings = {
	binaryPath: "",
	syncOnChange: true,
	snapshotQuietSeconds: SNAPSHOT_QUIET_DEFAULT,
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
			.setName("Snapshot after a quiet period")
			.setDesc("Seconds with no file change before Atlas commits your edits to the vault's history. 0 turns it off.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.setPlaceholder(String(DEFAULT_SETTINGS.snapshotQuietSeconds)).setValue(String(this.plugin.settings.snapshotQuietSeconds));
				text.inputEl.addEventListener("change", async () => {
					const seconds = quietSeconds(text.getValue());
					text.setValue(String(seconds));
					await this.plugin.setSnapshotQuiet(seconds);
				});
			});

		new Setting(containerEl).setName("Agents").setHeading();
		const agents = containerEl.createDiv();
		void this.agents(agents);
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
		intro.setText(`Start agent, Resume, and the palette's agents without Duet read these. ${shortHome(config.files.global)} holds them for every vault; .atlas/config.json in this vault overrides them, key by key. atlas-obsidian config shows the result.`);

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
