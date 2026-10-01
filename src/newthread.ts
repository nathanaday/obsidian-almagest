import { App, Modal, Setting } from "obsidian";

/**
 * Asks for a new thread of a chord: its title, and its idea in a few words. Code writes
 * everything else of the stub. The idea may stay empty; the title is the idea then.
 */
export class NewThreadModal extends Modal {
	private title = "";
	private idea = "";

	constructor(app: App, private chord: string, private done: (title: string, idea: string) => void) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(`New thread in ${this.chord}`);
		const submit = () => {
			const title = this.title.trim();
			if (!title) return;
			this.close();
			this.done(title, this.idea.trim());
		};
		new Setting(this.contentEl).setName("Title").addText((text) => {
			text.setPlaceholder("Annotate the dataset").onChange((v) => (this.title = v));
			text.inputEl.addClass("atlas-reason-input");
			text.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					submit();
				}
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});
		new Setting(this.contentEl)
			.setName("Idea")
			.setDesc("What this thread delivers, in your words. An agent writes the spec from it later.")
			.addTextArea((area) => {
				area.setPlaceholder("Label every image of the train and val splits.").onChange((v) => (this.idea = v));
				area.inputEl.rows = 4;
				area.inputEl.addClass("atlas-idea-input");
				area.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						submit();
					}
				});
			});
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Plant the thread").setCta().onClick(submit));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
