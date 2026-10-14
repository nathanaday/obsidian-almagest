// What the palette's navigator shows, from `neighbors --json`. Pure: the tests cover it.

import { plural, Ref } from "./palettestate";

/** A document as `neighbors --json` names it. */
export interface NavRef extends Ref {
	description?: string;
}

/** What `neighbors --json` prints: the documents around one document, each in one group. */
export interface Neighbors {
	document: NavRef;
	up?: NavRef[] | null;
	beside?: NavRef[] | null;
	below?: NavRef[] | null;
	sources_below?: NavRef[] | null;
	sources?: NavRef[] | null;
	cited_by?: NavRef[] | null;
}

type GroupKey = Exclude<keyof Neighbors, "document">;

/** The groups in the order the navigator shows them, with their labels. */
export const NAV_GROUPS: [GroupKey, string][] = [
	["up", "Up"],
	["beside", "Beside"],
	["below", "Below"],
	["sources_below", "Sources below"],
	["sources", "Sources"],
	["cited_by", "Cited by"],
];

/** The groups that hold a document, in order. */
export function navGroups(n: Neighbors): { key: GroupKey; label: string; refs: NavRef[] }[] {
	return NAV_GROUPS.map(([key, label]) => ({ key, label, refs: n[key] ?? [] })).filter((g) => g.refs.length > 0);
}

/** The navigator's line on the palette's home: the document and what lies around it. */
export function navLine(n: Neighbors | null, onDocument: boolean): string {
	if (!n) return onDocument ? "Reading the document…" : "Open a wiki document";
	const groups = navGroups(n);
	if (groups.length === 0) return `${n.document.title} · nothing around it`;
	return `${n.document.title} · ${groups.map((g) => plural(g.refs.length, g.label.toLowerCase(), g.label.toLowerCase())).join(", ")}`;
}

/** The line under a neighbor: its kind or type, and its description, cut to max characters. */
export function navMeta(r: NavRef, max = 140): string {
	const desc = (r.description ?? "").trim();
	const cut = desc.length > max ? `${desc.slice(0, max - 1).trimEnd()}…` : desc;
	return [r.kind || r.type || "", cut].filter((x) => x).join(" · ");
}
