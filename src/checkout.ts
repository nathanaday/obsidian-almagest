import { App, ButtonComponent, MarkdownView, Modal, Notice, Setting } from "obsidian";
import { CHECKOUT, Checkout, Returned, checkoutTitle, oneLine, skippedLine } from "./checkoutstate";
import type AtlasPlugin from "./main";
import { checkoutMessage } from "./messages";

/** Starts the librarian on a request: in Duet, else in a terminal. */
export function startCheckout(plugin: AtlasPlugin, request: string): Promise<void> {
	return plugin.runAgent(checkoutMessage(request), checkoutTitle(request), "checkout");
}

/**
 * Proposes the edited copies of a checkout as one change, and opens the change. A notice
 * names the copies that the return left out.
 */
export async function returnCheckout(plugin: AtlasPlugin, c: Checkout): Promise<void> {
	// An edit typed a moment ago returns with its copy.
	for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view;
		if (view instanceof MarkdownView && view.file?.path.startsWith(`${c.folder}/`)) await view.save();
	}
	const { returned } = await plugin.atlas<{ returned: Returned }>([CHECKOUT, "return", c.folder]);
	const line = skippedLine(returned.skipped);
	if (line) new Notice(`Atlas: ${line}`, 15_000);
	if (returned.change?.ref) await plugin.openWhenSeen(returned.change.ref.path, true);
}

/** Asks for the request; Check out starts the librarian. */
export class CheckoutModal extends Modal {
	private request = "";

	constructor(
		app: App,
		private start: (request: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Check out material");
		const el = this.contentEl;
		el.addClass("atlas-checkout");
		el.createEl("p", {
			text: `The librarian finds the documents that serve your request and copies them into ${CHECKOUT}/, with a reading list. Edit the copies as you like. Return proposes your edits to the wiki as a change.`,
		});
		let go: ButtonComponent | undefined;
		const submit = () => {
			const request = oneLine(this.request);
			if (!request) return;
			this.close();
			this.start(request);
		};
		new Setting(el)
			.setName("Request")
			.setDesc("One line: the subject, in your words.")
			.addText((text) => {
				text.setPlaceholder("reinforcement learning").onChange((v) => {
					this.request = v;
					go?.setDisabled(oneLine(v) === "");
				});
				text.inputEl.addClass("atlas-checkout-input");
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter" && !e.isComposing) {
						e.preventDefault();
						submit();
					}
				});
				window.setTimeout(() => text.inputEl.focus(), 0);
			});
		new Setting(el)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				go = b.setButtonText("Check out").setCta().setDisabled(true).onClick(submit);
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
