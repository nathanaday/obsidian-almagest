// The first message of each agent the palette starts. Pure: the tests cover them, and the
// skills read these words.

import { oneLine } from "./checkoutstate";

/** A work document: the change document an agent reports into and proposes into. */
export interface WorkDoc {
	id: string;
	title: string;
}

const MAX_NAMED = 10;

function report(doc: WorkDoc, what: string): string {
	return `Your work document is [[${doc.title}]] (${doc.id}): report each step with change progress, and propose ${what} with change propose and id ${doc.id}.`;
}

/** Ingest: the files of ingest/, into the work document the palette started. */
export function ingestMessage(doc: WorkDoc): string {
	return `/atlas-obsidian:wiki-ingest Ingest the files of ingest/ into the wiki. ${report(doc, "into it")}`;
}

/** Repair with an agent: the lint findings that a change repairs. */
export function repairMessage(doc: WorkDoc): string {
	return `/atlas-obsidian:wiki-review Repair the lint findings that a change repairs. ${report(doc, "the repairs into it")}`;
}

/** Publish: an edition of the user's journal, captured as a source, into the work document the palette started. */
export function publishMessage(edition: WorkDoc, doc: WorkDoc): string {
	return `/atlas-obsidian:wiki-sync Absorb the source [[${edition.title}]] (${edition.id}), the user's journal edition. Cite it where its ideas land. ${report(doc, "into it")}`;
}

/** Checkout: the librarian gathers the material on the user's request into a checkout. */
export function checkoutMessage(request: string): string {
	return `/atlas-obsidian:wiki-checkout Check out the material on: ${oneLine(request)}`;
}

function named(list: { title: string }[]): string {
	const names = list.slice(0, MAX_NAMED).map((b) => `[[${b.title}]]`);
	const more = list.length - names.length;
	if (more > 0) names.push(`${more} more`);
	return names.join(", ");
}

/**
 * Resolve with an agent: a document that safe delete kept because documents link it. The
 * files of the user's own that link it too stay as they are, so the agent proposes no remove.
 */
export function resolveMessage(target: { title: string; path: string }, backlinks: { title: string }[], yours: { title: string }[] = []): string {
	const head = `/atlas-obsidian:wiki-edit Remove [[${target.title}]] (${target.path}), which ${named(backlinks)} ${backlinks.length === 1 ? "links" : "link"}: point each backlink elsewhere, or drop it`;
	if (yours.length === 0) return `${head}, then propose a remove.`;
	return `${head}. ${named(yours)} ${yours.length === 1 ? "is" : "are"} the user's to fix, so leave ${yours.length === 1 ? "it" : "them"} and propose no remove; the user runs Safe delete again.`;
}

/** Create on a new mark: an agent drafts the topic from the wikified note into its work document. */
export function draftMessage(title: string, note: string, doc: WorkDoc): string {
	return `/atlas-obsidian:wiki-edit Draft a topic titled ${title} from [[${note}]] and what the wiki holds; give it a why. ${report(doc, "into it")}`;
}

/** Wikify this note: an agent marks the copy with what the wiki knows and the subjects worth a topic. */
export function wikifyMessage(copy: string): string {
	return `/atlas-obsidian:wiki-wikify Wikify [[${copy}]]: mark what the wiki knows and the subjects worth a topic, with wikify mark.`;
}
