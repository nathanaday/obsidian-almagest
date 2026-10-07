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

/** Resolve with an agent: a file that safe delete kept because these documents link it. */
export function resolveMessage(target: { title: string; path: string }, backlinks: { title: string }[]): string {
	const names = backlinks.slice(0, MAX_NAMED).map((b) => `[[${b.title}]]`);
	const more = backlinks.length - names.length;
	if (more > 0) names.push(`${more} more`);
	return `/atlas-obsidian:wiki-edit Remove [[${target.title}]] (${target.path}), which ${names.join(", ")} ${backlinks.length === 1 ? "links" : "link"}: point each backlink elsewhere, or drop it, then propose a remove.`;
}
