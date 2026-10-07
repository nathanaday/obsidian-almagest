// Pure functions: no Obsidian, no Node. The tests cover them.

// The folders of the vault, as vault.go names them.
export const DOCUMENTS = "source-core/documents/";
const WIKI_VIEW = "wiki-view/";
const NAV_FOLDER = "wiki-view/nav/";
export const INGEST = "ingest/";

/** Whether a path lies in source-core/documents. */
export function isDocumentPath(path: string): boolean {
	return path.startsWith(DOCUMENTS);
}

export interface Synced {
	moved?: string[] | null;
	lost?: string[] | null;
	knowledge?: string[] | null;
	sessions?: string[] | null;
	settings?: boolean;
	views?: number;
	strays?: { from: string; to: string }[] | null;
	skipped?: string[] | null;
}

/**
 * The protocols this plugin reads: the version of the commands, flags, and JSON of the
 * binary (`almagest version --json` prints its own). Each side names the update it needs.
 */
export const PROTOCOLS = [1];

/** How to install the agent plugin, whose launcher installs the binary. */
const INSTALL_AGENT =
	"Install the Almagest agent plugin: in Claude Code, claude plugin marketplace add nathanaday/almagest, then claude plugin install almagest@nathanaday-almagest, and start one session in the vault. Its first session installs the binary. Or set the binary's path in the Almagest settings.";

/** What `almagest version --json` prints. A binary that prints no protocol reads as 0. */
export interface BinaryInfo {
	version: string;
	protocol?: number;
}

/**
 * Why the plugin cannot use the binary, with the update that fixes it; or "" when it can.
 * info is null when no binary was found or it did not run.
 */
export function binaryProblem(info: BinaryInfo | null, found: string | null): string {
	if (!found) return `Almagest needs its binary, and none is installed. ${INSTALL_AGENT}`;
	if (!info) return `Almagest cannot run its binary at ${found}. ${INSTALL_AGENT}`;
	const protocol = info.protocol ?? 0;
	if (protocol < Math.min(...PROTOCOLS)) {
		return `almagest ${info.version} is older than this plugin reads. Update the agent plugin (claude plugin update almagest@nathanaday-almagest), then start a session in the vault.`;
	}
	if (protocol > Math.max(...PROTOCOLS)) {
		return `almagest ${info.version} is newer than this plugin reads. Update Almagest in Obsidian's community plugins.`;
	}
	return "";
}

/**
 * The places to look for the binary after the setting: the link to the binary that the
 * agent plugin's launcher installed last. PATH and the system folders are left out, so
 * another tool's binary never runs in its place.
 */
export function binaryCandidates(home: string): string[] {
	return [`${home}/.almagest/bin/almagest`];
}

/** The override when it is set, else the first candidate that exists. */
export function chooseBinary(
	override: string,
	candidates: string[],
	exists: (path: string) => boolean,
	home: string,
): string | null {
	const set = override.trim();
	if (set !== "") return expandHome(set, home);
	return candidates.find(exists) ?? null;
}

export function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return home + path.slice(1);
	return path;
}

/** The message after "almagest: " on the last line of stderr that has one. */
export function errorMessage(stderr: string): string {
	const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l !== "");
	for (const line of [...lines].reverse()) {
		if (line.startsWith("almagest: ")) return line.slice("almagest: ".length);
	}
	return lines[lines.length - 1] ?? "";
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** One line for a sync result. */
export function syncSummary(s: Synced): string {
	const parts: string[] = [];
	const add = (list: string[] | null | undefined, one: string, many: string) => {
		const n = list?.length ?? 0;
		if (n) parts.push(plural(n, one, many));
	};
	add(s.knowledge, "knowledge document", "knowledge documents");
	add(s.moved, "document moved back", "documents moved back");
	add(s.lost, "lost session", "lost sessions");
	add(s.sessions, "session callout", "session callouts");
	if (s.settings) parts.push("the harness settings");
	if (s.views) parts.push(plural(s.views, "view", "views"));
	add(s.skipped, "document left as saved", "documents left as saved");
	if (parts.length === 0) return "Generated files are up to date.";
	return `Synced ${parts.join(", ")}.`;
}

/** Every path a sync wrote. */
export function syncedPaths(s: Synced): string[] {
	const strays = (s.strays ?? []).flatMap((m) => [m.from, m.to]);
	return [...(s.knowledge ?? []), ...(s.moved ?? []), ...(s.lost ?? []), ...(s.sessions ?? []), ...strays];
}

/** One notice per note of the user's that a sync moved out of wiki-view/. */
export function strayNotices(s: { strays?: { from: string; to: string }[] | null }): string[] {
	return (s.strays ?? []).map(movedLine);
}

/** One notice per note of the user's that a write moved out of wiki-view/: any JSON
 * result of the binary may hold them under moved_from_wiki_view. */
export function movedNotices(out: unknown): string[] {
	if (typeof out !== "object" || out === null) return [];
	const moved = (out as { moved_from_wiki_view?: unknown }).moved_from_wiki_view;
	if (!Array.isArray(moved)) return [];
	return moved
		.filter((m: unknown): m is { from: string; to: string } => {
			const x = m as { from?: unknown; to?: unknown } | null;
			return typeof x?.from === "string" && typeof x?.to === "string";
		})
		.map(movedLine);
}

function movedLine(m: { from: string; to: string }): string {
	return `Moved ${m.from} to ${m.to}: code writes every file in ${WIKI_VIEW}, so your note waits in ${INGEST}.`;
}

/**
 * The counts of a change without the zeros. The frontmatter holds a string such as
 * "3 create, 1 modify, 0 rename, …, 2 link rewrites"; a Preview holds an object.
 */
export function countsLine(counts: unknown): string {
	if (typeof counts === "string") {
		return counts
			.split(",")
			.map((p) => p.trim())
			.filter((p) => p !== "" && !/^0\s/.test(p))
			.join(", ");
	}
	if (counts && typeof counts === "object") {
		const names: Record<string, string> = {
			create: "create",
			modify: "modify",
			rename: "rename",
			remove: "remove",
			confirm: "confirm",
			retag: "retag",
			link_rewrites: "link rewrites",
			tag_rewrites: "tag rewrites",
		};
		return Object.entries(names)
			.map(([key, name]) => [(counts as Record<string, unknown>)[key], name] as const)
			.filter((e): e is readonly [number, string] => typeof e[0] === "number" && e[0] > 0)
			.map(([n, name]) => `${n} ${name}`)
			.join(", ");
	}
	return "";
}

/** "just now", "3 min ago", "2 h ago", "4 days ago". Empty when the time does not parse. */
export function formatAgo(when: string | Date | undefined, now: Date): string {
	if (when === undefined || when === "") return "";
	const t = when instanceof Date ? when : new Date(String(when));
	if (Number.isNaN(t.getTime())) return "";
	const s = Math.max(0, Math.floor((now.getTime() - t.getTime()) / 1000));
	if (s < 60) return "just now";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h} h ago`;
	const d = Math.floor(h / 24);
	return d === 1 ? "1 day ago" : `${d} days ago`;
}

/** "[[Title|alias]]" or "[[Title#heading]]" to "Title"; plain text stays. */
export function linkTitle(value: unknown): string {
	if (typeof value !== "string") return "";
	const m = /^\s*\[\[([^\]|#]*)(?:[#|][^\]]*)?\]\]\s*$/.exec(value);
	return (m?.[1] ?? value).trim();
}

/** The three types of source-core/documents, as schema.DocumentTypes lists them. */
const DOCUMENT_TYPES = ["source", "repository", "topic"];

/** Whether a frontmatter type is one of the document types the navigator lists. */
export function isDocumentType(type: unknown): boolean {
	return DOCUMENT_TYPES.includes(String(type));
}

/** A list property as strings; a single string is a list of one. */
export function asList(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
	if (typeof value === "string" && value !== "") return [value];
	return [];
}

/** The last non-empty line of the "## Progress" section, without its list marker. */
export function lastProgressLine(markdown: string): string {
	let inside = false;
	let last = "";
	for (const raw of markdown.split("\n")) {
		const line = raw.trim();
		if (/^#{1,6}\s/.test(line)) {
			if (inside) break;
			inside = /^##\s+Progress\s*$/i.test(line);
			continue;
		}
		if (inside && line !== "") last = line.replace(/^[-*+]\s+(\[.\]\s+)?/, "");
	}
	return last;
}

/** Whether a change to a file should refresh the views: any markdown file outside them. */
export function isWatchedPath(path: string): boolean {
	return path.endsWith(".md") && !path.startsWith(WIKI_VIEW) && !path.startsWith(".");
}

/** Whether a file event counts toward a quiet snapshot: any path outside Obsidian's
 * config folder and wiki-view/. */
export function isSnapshotPath(path: string, configDir: string): boolean {
	return path !== "" && !path.startsWith(configDir + "/") && !path.startsWith(WIKI_VIEW);
}

export const SNAPSHOT_QUIET_DEFAULT = 120;
/** One day: a longer timeout overflows the browser's timer and fires at once. */
const SNAPSHOT_QUIET_MAX = 86_400;

/** The quiet period of snapshots in whole seconds, from a setting or a field: empty or
 * not a number takes the default, and the rest is clamped to 0 (off) through one day. */
export function quietSeconds(value: unknown): number {
	const raw = typeof value === "string" ? value.trim() : value;
	if (raw === "" || raw === null || raw === undefined || typeof raw === "boolean") return SNAPSHOT_QUIET_DEFAULT;
	const n = Number(raw);
	if (!Number.isFinite(n)) return SNAPSHOT_QUIET_DEFAULT;
	return Math.min(SNAPSHOT_QUIET_MAX, Math.max(0, Math.round(n)));
}

/** Whether an error of the binary says another write holds the vault's lock. */
export function isLockHeld(message: string): boolean {
	return /almagest\.lock|holds the lock/.test(message);
}

/** The title of a tag's view: "Tag · school › cs513". */
function tagTitle(tag: string): string {
	return "Tag · " + tag.split("/").join(" › ");
}

/** The view note of a tag, in a folder per tag part under wiki-view/nav. */
export function tagViewPath(tag: string): string {
	return `${NAV_FOLDER}${tag}/${tagTitle(tag)}.md`;
}

/** A tag as the property holds it: lower case, without #. */
export function normalTag(t: string): string {
	return t.trim().replace(/^#/, "").toLowerCase();
}

/** Whether a list of tags holds t: it lists t or a tag below it. */
export function holds(list: string[], t: string): boolean {
	return list.some((x) => x === t || x.startsWith(t + "/"));
}

/** Every tag of a list and the tags above each. */
export function expandTags(list: string[]): string[] {
	const out = new Set<string>();
	for (const t of list) {
		const parts = t.split("/");
		for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join("/"));
	}
	return [...out];
}

/** One document as the Almagest navigator sees it. */
export interface TagDoc {
	path: string;
	title: string;
	type: string;
	kind: string;
	status: string;
	description: string;
	tags: string[];
}

export interface Facet {
	tag: string;
	count: number;
}

/** The documents that hold every chosen tag, and the other tags among them, most first. */
/** A tag as the navigator shows it under the chosen ones: below a chosen tag, the part after it. */
export function relativeTag(tag: string, chosen: string[]): string {
	const above = chosen.filter((c) => tag.startsWith(c + "/")).sort((a, b) => b.length - a.length)[0];
	return above ? "› " + tag.slice(above.length + 1).split("/").join(" › ") : "#" + tag;
}

export function narrow(docs: TagDoc[], chosen: string[]): { matches: TagDoc[]; with: Facet[] } {
	const matches = docs.filter((d) => chosen.every((t) => holds(d.tags, t)));
	const counts = new Map<string, number>();
	const skip = new Set<string>(expandTags(chosen));
	for (const d of matches) {
		for (const t of expandTags(d.tags)) {
			if (skip.has(t)) continue;
			counts.set(t, (counts.get(t) ?? 0) + 1);
		}
	}
	const withTags = [...counts.entries()]
		.map(([tag, count]) => ({ tag, count }))
		.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
	return { matches, with: withTags };
}

/** The top tags of the vault with their counts, most first. */
export function topTags(docs: TagDoc[]): Facet[] {
	const counts = new Map<string, number>();
	for (const d of docs) {
		for (const t of expandTags(d.tags)) {
			if (!t.includes("/")) counts.set(t, (counts.get(t) ?? 0) + 1);
		}
	}
	return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** The order the navigator groups documents in. */
const NAV_GROUPS: { name: string; test: (d: TagDoc) => boolean }[] = [
	{ name: "Topics", test: (d) => d.type === "topic" },
	{ name: "Sources", test: (d) => d.type === "source" },
	{ name: "Repositories", test: (d) => d.type === "repository" },
];

/** Documents in the navigator's groups; a document goes in the first group that takes it. */
export function groupDocs(docs: TagDoc[]): { name: string; docs: TagDoc[] }[] {
	const out = NAV_GROUPS.map((g) => ({ name: g.name, docs: [] as TagDoc[] }));
	for (const d of docs) {
		const i = NAV_GROUPS.findIndex((g) => g.test(d));
		out[i]?.docs.push(d);
	}
	for (const g of out) g.docs.sort((a, b) => a.title.localeCompare(b.title));
	return out.filter((g) => g.docs.length > 0);
}

/** The id and path an almagest-repo code block holds: "doc-abc123 · ~/code/x · …". */
export function repoBlock(source: string): { id: string; path: string } {
	const [id, path] = source.trim().split(" · ");
	return { id: (id ?? "").trim(), path: (path ?? "").trim() };
}

/** The layout a vault document records: 0 when it records none. */
export function layoutOf(fields: Record<string, unknown> | undefined): number {
	const n = Number(fields?.layout ?? 0);
	return Number.isFinite(n) ? n : 0;
}

/** The layout this plugin reads, as the vault document records it. */
export const LAYOUT = 7;

/** The vault document, which records the layout. */
export const VAULT_DOCUMENT = "Almagest.md";
