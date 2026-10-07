import { App, ButtonComponent, MarkdownView, Modal, Notice, Setting, TFile, WorkspaceLeaf } from "obsidian";
import { CHECKOUT, Checkout, Returned, checkoutTitle, oneLine, returnedLine, skippedLine } from "./checkoutstate";
import type AlmagestPlugin from "./main";
import { checkoutMessage } from "./messages";

/** Starts the librarian on a request: in Duet, else in a terminal. */
export function startCheckout(plugin: AlmagestPlugin, request: string): Promise<void> {
	return plugin.runAgent(checkoutMessage(request), checkoutTitle(request), "checkout");
}

/**
 * Returns a checkout in one click: the binary proposes the edited copies as one change and
 * moves the checkout to tool/returned/. A notice says how it went, with a link to the
 * change, or why it failed.
 */
export async function returnCheckout(plugin: AlmagestPlugin, c: Checkout): Promise<void> {
	// An edit typed a moment ago returns with its copy. A note of the checkout that is open
	// leaves its tab while the files move, and comes back from its new place.
	const open: { leaf: WorkspaceLeaf; rest: string }[] = [];
	for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view;
		if (view instanceof MarkdownView && view.file?.path.startsWith(`${c.folder}/`)) {
			await view.save();
			open.push({ leaf, rest: view.file.path.slice(c.folder.length) });
			await leaf.setViewState({ type: "empty" });
		}
	}
	const reopen = async (folder: string) => {
		for (const { leaf, rest } of open) {
			const file = await waitForFile(plugin, folder + rest);
			if (file) await leaf.openFile(file);
		}
	};
	let returned: Returned;
	try {
		({ returned } = await plugin.almagest<{ returned: Returned }>([CHECKOUT, "return", c.folder]));
	} catch (e) {
		new Notice(`Almagest: the return of ${c.name} failed: ${(e as Error).message}`, 15_000);
		await reopen(c.folder);
		return;
	}
	await reopen(returned.folder ?? c.folder);
	const ref = returned.change?.ref;
	const fragment = createFragment((f) => {
		f.appendText(`Almagest: ${returnedLine(c.name, returned)}`);
		const skipped = skippedLine(returned.skipped);
		if (skipped) f.appendText(` Note: ${skipped}`);
		if (ref) {
			f.appendText(" ");
			const open = f.createEl("a", { text: "Open the change", href: "#", cls: "almagest-notice-link" });
			open.onclick = (evt) => {
				evt.preventDefault();
				void plugin.openWhenSeen(ref.path, true);
			};
		}
	});
	new Notice(fragment, 12_000);
	if (returned.warning) new Notice(`Almagest: ${returned.warning}`, 15_000);
}

/** A file once Obsidian sees it, after a move on disk; null when it does not within two seconds. */
async function waitForFile(plugin: AlmagestPlugin, path: string): Promise<TFile | null> {
	for (let i = 0; i < 20; i++) {
		const file = plugin.app.vault.getFileByPath(path);
		if (file) return file;
		await new Promise((resolve) => window.setTimeout(resolve, 100));
	}
	return null;
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
		el.addClass("almagest-checkout");
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
				text.setPlaceholder("Reinforcement learning").onChange((v) => {
					this.request = v;
					go?.setDisabled(oneLine(v) === "");
				});
				text.inputEl.addClass("almagest-checkout-input");
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
