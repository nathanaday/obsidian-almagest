// Quick search and Make topic: the wiki's hits for a selected term, and a topic made from
// it. Pure: the tests cover it.

import { oneLine } from "./checkoutstate";
import { SESSIONS, TRASH } from "./helpers";

/** One hit of `almagest search --json`. */
export interface SearchHit {
	ref: { id: string; type: string; kind?: string; title: string; path: string; description?: string; status?: string };
	snippet?: string;
}

export interface SearchResult {
	hits: SearchHit[] | null;
	total: number;
}

/** The types quick search finds: the wiki's documents, not its records. */
const SEARCH_TYPES = ["topic", "source", "repository"];
const SEARCH_LIMIT = 20;

/** The query as `search` takes it: one line, without a leading dash that would read as an option. */
export function searchQuery(text: string): string {
	return oneLine(text).replace(/^-+\s*/, "");
}

/** The arguments of `almagest search` for a query. */
export function searchArgs(query: string): string[] {
	const args = ["search", searchQuery(query), "--limit", String(SEARCH_LIMIT)];
	for (const t of SEARCH_TYPES) args.push("--type", t);
	return args;
}

// The characters a title cannot hold, as doc.CleanTitle strips them.
const TITLE_STRIP = /[/\\:*?"<>|[\]#^→]/g;
/** Whether a character is a control character, as Go's unicode.IsControl reads it. */
const isControl = (c: string) => c <= "\u001f" || (c >= "\u007f" && c <= "\u009f");
const MAX_TITLE_BYTES = 150;
/** The prefixes of the titles of code's notes, as vault.ReservedPrefixes lists them. */
const RESERVED_PREFIXES = ["Tag · ", "View · ", "Checkout · ", "Journal · "];

/** A title as the binary takes it: no character a file name or a link cannot hold, whitespace folded. */
export function cleanTitle(text: string): string {
	return [...text].map((c) => (isControl(c) ? " " : c)).join("").replace(TITLE_STRIP, "").split(/\s+/).filter(Boolean).join(" ").replace(/^\.+/, "").trim();
}

/** The title of a topic made from a selected term: clean, with a capital first letter when the first word is lower case. */
export function topicTitle(term: string): string {
	const title = cleanTitle(term);
	const first = title.split(" ")[0] ?? "";
	return first === first.toLowerCase() ? title.charAt(0).toUpperCase() + title.slice(1) : title;
}

/** Why the binary would refuse a title, or "". */
export function titleProblem(title: string): string {
	if (!title) return "Give a title of words.";
	if (new TextEncoder().encode(title).length > MAX_TITLE_BYTES) return `A title holds at most ${MAX_TITLE_BYTES} bytes.`;
	const prefix = RESERVED_PREFIXES.find((p) => title.startsWith(p));
	if (prefix) return `A title cannot start with "${prefix.trim()}", which Almagest keeps for its own notes.`;
	return "";
}

const key = (s: string) => s.normalize("NFC").toLowerCase();

/** The title of the document that holds a title, by its title first, then by an alias; or null. */
export function existingTitle(title: string, docs: { title: string; aliases: string[] }[]): string | null {
	const k = key(title);
	return docs.find((d) => key(d.title) === k)?.title ?? docs.find((d) => d.aliases.some((a) => key(a) === k))?.title ?? null;
}

/** Whether a hit holds the title, so Make topic would only repeat it. */
export function hitHolds(hits: SearchHit[], title: string): boolean {
	return hits.some((h) => key(h.ref.title) === key(title));
}

/** The offset where a markdown text's body starts, after its frontmatter. */
function bodyStart(text: string): number {
	const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	return m ? m[0].length : 0;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The first place in a note's body that names the query, as whole words without regard to
 * case: the whole query, else its longest word of three letters or more; or null. Search
 * ranks by words, so a hit may hold no word of the query as written.
 */
export function findOccurrence(text: string, query: string): { from: number; to: number } | null {
	const start = bodyStart(text);
	const body = text.slice(start);
	const words = searchQuery(query)
		.split(" ")
		.filter((w) => w.length >= 3)
		.sort((a, b) => b.length - a.length);
	for (const term of [searchQuery(query), ...words]) {
		if (!term) continue;
		const m = new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, "iu").exec(body);
		if (m) return { from: start + m.index, to: start + m.index + m[0].length };
	}
	return null;
}

/** A snippet as plain text: each wikilink shows its text, and whitespace folds. */
export function plainSnippet(snippet: string): string {
	return oneLine(snippet.replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_, target: string, alias?: string) => alias ?? target));
}

/** A text cut into parts, each marked when it is a word of the query, for highlighting. */
export function highlightParts(text: string, query: string): { text: string; hit: boolean }[] {
	const words = [...new Set(searchQuery(query).toLowerCase().split(" ").filter((w) => w.length >= 2))];
	if (words.length === 0) return text ? [{ text, hit: false }] : [];
	const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "giu");
	const parts: { text: string; hit: boolean }[] = [];
	let at = 0;
	for (const m of text.matchAll(re)) {
		if (m.index > at) parts.push({ text: text.slice(at, m.index), hit: false });
		parts.push({ text: m[0], hit: true });
		at = m.index + m[0].length;
	}
	if (at < text.length) parts.push({ text: text.slice(at), hit: false });
	return parts;
}

/** The folders whose notes code writes or keeps as a record: a selection there gets no link. */
const NO_LINKS = ["changes", SESSIONS, "wiki-view", TRASH, "tool/source-core/originals"];

/** Why a note takes no link from a selection, or "". configDir is Obsidian's folder, `Vault#configDir`. */
export function linkBlocked(path: string, configDir: string): string {
	if (!/\.md$/i.test(path)) return "Almagest links a selection in a markdown note.";
	const k = path.toLowerCase();
	const folder = [...NO_LINKS, configDir].find((d) => k.startsWith(d.toLowerCase() + "/"));
	return folder ? `Almagest writes no link into ${folder}/, which holds code's notes or records.` : "";
}

/** Whether a selection can become a link: one line, and no link of its own. */
export function linkableText(text: string): boolean {
	return text.trim() !== "" && !/[\r\n]/.test(text) && !/\[\[|\]\]/.test(text);
}
