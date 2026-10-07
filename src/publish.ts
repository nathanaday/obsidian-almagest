import { App, Modal, Notice } from "obsidian";
import { JOURNALS, JournalVolume, editionTitle, journalVolumes, numbered, publishBlocked } from "./journalstate";
import type AtlasPlugin from "./main";
import { WorkDoc, publishMessage } from "./messages";
import { plural } from "./palettestate";

interface Captured extends WorkDoc {
	path: string;
}

/** What `journal publish --json` prints. */
interface Published {
	published: { source: Captured; volume: string; edition: string; hash: string; commit?: string };
}

/** Asks the user to publish a volume; Publish captures it and starts the agent that absorbs it. */
export function confirmPublish(plugin: AtlasPlugin, vol: JournalVolume): void {
	const title = editionTitle(vol.volume, new Date());
	new PublishModal(plugin.app, vol, title, numbered(vol.edition, title), () => void publish(plugin, vol.volume)).open();
}

/** Publish for the volume of a path, from the command: the binary says whether the volume has a change. */
export async function confirmPublishOf(plugin: AtlasPlugin, volume: string): Promise<void> {
	try {
		const { journals } = await plugin.atlas<{ journals: Partial<JournalVolume>[] | null }>(["journal", "list"]);
		const vol = journalVolumes(journals).find((v) => v.volume === volume);
		if (!vol) {
			new Notice(`Atlas: ${JOURNALS}/${volume} is not a journal volume.`);
			return;
		}
		const why = publishBlocked(vol);
		if (why) new Notice(`Atlas: ${vol.name}: ${why}`, 8000);
		else confirmPublish(plugin, vol);
	} catch (e) {
		new Notice(`Atlas: ${(e as Error).message}`, 10_000);
	}
}

/**
 * Captures the volume as an edition, starts its work document and opens it, and starts the
 * agent that absorbs the edition. One publish runs at a time.
 */
async function publish(plugin: AtlasPlugin, volume: string): Promise<void> {
	if (plugin.publishing) return;
	plugin.setPublishing(volume);
	let edition: Captured | undefined;
	try {
		// The prefix keeps a volume whose name begins with a dash from reading as an option.
		const { published } = await plugin.atlas<Published>(["journal", "publish", `${JOURNALS}/${volume}`]);
		edition = published.source;
		new Notice(`Atlas: published ${edition.title}.`);
		const { ref: doc } = await plugin.atlas<{ ref: Captured }>(["change", "start", "--kind", "ingest", "--title", `Ingest ${edition.title}`]);
		await plugin.openWhenSeen(doc.path, true);
		await plugin.runAgent(publishMessage(edition, doc), `Agent · ${doc.title}`, "publish");
	} catch (e) {
		const message = (e as Error).message;
		new Notice(
			edition
				? `Atlas: the agent for ${edition.title} did not start: ${message}. The edition waits as a pending source; wiki-sync absorbs it.`
				: `Atlas: ${message}`,
			10_000,
		);
	} finally {
		plugin.setPublishing("");
	}
}

/** Names the edition that Publish makes, and publishes on a second click. */
class PublishModal extends Modal {
	constructor(
		app: App,
		private vol: JournalVolume,
		private title: string,
		private numbered: boolean,
		private publish: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { vol } = this;
		this.setTitle(`Publish ${vol.name}`);
		const el = this.contentEl;
		el.addClass("atlas-publish");
		el.createEl("p", { text: `Publish captures the ${plural(vol.notes, "note", "notes")} of ${JOURNALS}/${vol.volume}/ as one source:` });
		el.createDiv({ cls: "atlas-publish-title", text: this.title });
		if (this.numbered) el.createEl("p", { cls: "atlas-publish-quiet", text: "An edition of this day exists, so this one takes a number." });
		el.createEl("p", {
			text: "Then a work document opens, and an agent absorbs the edition into the wiki and cites it. You approve its changes. No agent edits the volume.",
		});
		const buttons = el.createDiv({ cls: "atlas-publish-buttons" });
		buttons.createEl("button", { text: "Cancel" }).onclick = () => this.close();
		const go = buttons.createEl("button", { cls: "mod-cta", text: "Publish" });
		go.onclick = () => {
			this.close();
			this.publish();
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
