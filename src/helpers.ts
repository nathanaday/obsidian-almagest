// Pure functions: no Obsidian, no Node. The tests cover them.

export interface Synced {
	moved?: string[] | null;
	lost?: string[] | null;
	threads?: string[] | null;
	knowledge?: string[] | null;
	sessions?: string[] | null;
	settings?: boolean;
	views?: number;
	strays?: { from: string; to: string }[] | null;
	skipped?: string[] | null;
}

/**
 * The places to look for the binary, in order, after the setting: the ones the agent
 * plugin's wrapper uses. PATH and the system folders are left out, so another tool's
 * binary never runs in its place.
 */
export function binaryCandidates(home: string): string[] {
	return [`${home}/.atlas/bin/atlas-obsidian`, `${home}/go/bin/atlas-obsidian`];
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

/** The message after "atlas: " on the last line of stderr that has one. */
export function errorMessage(stderr: string): string {
	const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l !== "");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].startsWith("atlas: ")) return lines[i].slice("atlas: ".length);
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
	add(s.threads, "thread document", "thread documents");
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
	return [...(s.threads ?? []), ...(s.knowledge ?? []), ...(s.moved ?? []), ...(s.lost ?? []), ...(s.sessions ?? []), ...strays];
}

/** One notice per note of the user's that a sync moved out of views/. */
export function strayNotices(s: Synced): string[] {
	return (s.strays ?? []).map(movedLine);
}

/** One notice per note of the user's that a write moved out of views/: any JSON result
 * of the binary may hold them under moved_from_views. */
export function movedNotices(out: unknown): string[] {
	if (typeof out !== "object" || out === null) return [];
	const moved = (out as { moved_from_views?: unknown }).moved_from_views;
	if (!Array.isArray(moved)) return [];
	return moved
		.filter((m): m is { from: string; to: string } => typeof m?.from === "string" && typeof m?.to === "string")
		.map(movedLine);
}

function movedLine(m: { from: string; to: string }): string {
	return `Moved ${m.from} to ${m.to}: code writes every file in views/, so your note waits in the inbox.`;
}

/**
 * The counts of a change without the zeros. The frontmatter holds a string such as
 * "3 create, 1 modify, 0 promote, …, 2 link rewrites"; a Preview holds an object.
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
			promote: "promote",
			rename: "rename",
			remove: "remove",
			confirm: "confirm",
			retag: "retag",
			link_rewrites: "link rewrites",
			tag_rewrites: "tag rewrites",
		};
		return Object.entries(names)
			.map(([key, name]) => [(counts as Record<string, unknown>)[key], name] as const)
			.filter(([n]) => typeof n === "number" && n > 0)
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
	return (m ? m[1] : value).trim();
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

const TASK_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[.\]\s/;
const MENTION = /@atlas(?![\w-])/g;

/** The [from, to) offsets of each "@atlas" in a task line; none in any other line. */
export function mentionRanges(line: string): [number, number][] {
	if (!TASK_LINE.test(line)) return [];
	return textMentions(line);
}

/** The [from, to) offsets of each "@atlas" that does not continue a word. */
export function textMentions(text: string): [number, number][] {
	const out: [number, number][] = [];
	for (const m of text.matchAll(MENTION)) {
		const i = m.index ?? 0;
		if (i > 0 && /[\w@.]/.test(text[i - 1])) continue;
		out.push([i, i + m[0].length]);
	}
	return out;
}

/** Whether a change to a file should refresh the views: any markdown file outside them. */
export function isWatchedPath(path: string): boolean {
	return path.endsWith(".md") && !path.startsWith("views/") && !path.startsWith(".");
}

export function waitingLabel(n: number): string {
	return n === 1 ? "Atlas: 1 session waits" : `Atlas: ${n} sessions wait`;
}

/** A CSS string literal of s. */
export function cssString(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ")}"`;
}

const TAG_FOLDER = "views/tags/";

/** The title of a tag's view: "Tag · school › cs513". */
export function tagTitle(tag: string): string {
	return "Tag · " + tag.split("/").join(" › ");
}

/** The tag a folder of views/tags stands for, or null. */
export function tagOfFolder(folder: string): string | null {
	if (!folder.startsWith(TAG_FOLDER)) return null;
	const tag = folder.slice(TAG_FOLDER.length);
	return tag === "" ? null : tag;
}

/** The view note inside a tag's folder. */
export function tagViewPath(tag: string): string {
	return `${TAG_FOLDER}${tag}/${tagTitle(tag)}.md`;
}

/** Whether a path is the view note of its own tag folder. */
export function isTagView(path: string): boolean {
	const i = path.lastIndexOf("/");
	if (i < 0) return false;
	const tag = tagOfFolder(path.slice(0, i));
	return tag !== null && tagViewPath(tag) === path;
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

/** One document as the Atlas navigator sees it. */
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

/** The order the navigator groups documents in: open chords and threads first. */
const ENDED_STATUS = new Set(["closed", "dropped", "resolved"]);

export const NAV_GROUPS: { name: string; test: (d: TagDoc) => boolean }[] = [
	{ name: "Open chords", test: (d) => d.type === "chord" && !ENDED_STATUS.has(d.status) },
	{ name: "Open threads", test: (d) => d.type === "stub" && !ENDED_STATUS.has(d.status) },
	{ name: "Topics", test: (d) => d.type === "topic" },
	{ name: "Sources", test: (d) => d.type === "source" },
	{ name: "Repositories", test: (d) => d.type === "repository" },
	{ name: "Specs, tasks, and verifications", test: (d) => d.type === "spec" || d.type === "tasks" || d.type === "verification" },
	{ name: "Ended threads and chords", test: (d) => d.type === "stub" || d.type === "chord" },
	{ name: "Events", test: (d) => d.type === "event" },
];

/** Documents in the navigator's groups; a document goes in the first group that takes it. */
export function groupDocs(docs: TagDoc[]): { name: string; docs: TagDoc[] }[] {
	const out = NAV_GROUPS.map((g) => ({ name: g.name, docs: [] as TagDoc[] }));
	for (const d of docs) {
		const i = NAV_GROUPS.findIndex((g) => g.test(d));
		if (i >= 0) out[i].docs.push(d);
	}
	for (const g of out) g.docs.sort((a, b) => a.title.localeCompare(b.title));
	return out.filter((g) => g.docs.length > 0);
}

/** An obsidian:// URI that opens the search for every chosen tag. */
export function searchURI(vault: string, chosen: string[]): string {
	const query = chosen.map((t) => `tag:#${t}`).join(" ");
	return `obsidian://search?vault=${encodeURIComponent(vault)}&query=${encodeURIComponent(query)}`;
}

/** The id and path an atlas-repo code block holds: "doc-abc123 · ~/code/x · …". */
export function repoBlock(source: string): { id: string; path: string } {
	const [id, path] = source.trim().split(" · ");
	return { id: (id ?? "").trim(), path: (path ?? "").trim() };
}

/** The layout a vault document records: 0 when it records none. */
export function layoutOf(fields: Record<string, unknown> | undefined): number {
	const n = Number(fields?.layout ?? 0);
	return Number.isFinite(n) ? n : 0;
}

/** The layout this plugin reads: the threads and chords of 8.0. */
export const LAYOUT = 4;

/** What a layout version is called. */
export function layoutName(layout: number): string {
	if (layout >= LAYOUT) return "8.0";
	return layout === 3 ? "7.x" : "6.x";
}

/** A stub or a chord, as the bar over it needs it. */
export interface BarDoc {
	id: string;
	type: "stub" | "chord";
	title: string;
	status: string;
	blocked: boolean;
	tasks: string;
	threads: string;
}

/** The line a user gives an agent to take up a thread or a chord. */
export function handoffLine(type: "stub" | "chord", id: string): string {
	return `Resume Atlas ${type === "chord" ? "chord" : "thread"} ${id}`;
}

const ENDED = ["closed", "dropped", "resolved"];

/** The status a bar shows: the status, a block, and the count of tasks or threads. */
export function barStatus(d: BarDoc): string {
	const parts = [d.blocked ? `${d.status}, blocked` : d.status];
	if (d.type === "stub" && d.tasks) parts.push(`${d.tasks} tasks`);
	if (d.type === "chord" && d.threads) parts.push(`${d.threads} threads closed`);
	return parts.join(" · ");
}

/**
 * The buttons of the bar over a stub or a chord. No button closes a thread: code closes
 * it when it is verified and the change that absorbs it is applied.
 */
export function barButtons(d: BarDoc): { id: string; label: string }[] {
	const out: { id: string; label: string }[] = [];
	const ended = ENDED.includes(d.status);
	if (!ended) {
		out.push({ id: "agent", label: "Start agent" });
		if (d.type === "chord") out.push({ id: "new", label: "New thread" });
		out.push({ id: "handoff", label: "Copy hand-off" });
	}
	if (d.type === "chord") out.push({ id: "canvas", label: "Canvas" });
	if (d.status === "dropped" || (d.type === "stub" && d.status === "resolved")) {
		out.push({ id: "reopen", label: "Reopen" });
		return out;
	}
	if (ended) return out;
	if (d.type === "stub") out.push(d.blocked ? { id: "unblock", label: "Unblock" } : { id: "block", label: "Block" });
	out.push({ id: "drop", label: "Drop" });
	return out;
}

/** What the binary says of a chord's canvas against its stubs. */
export interface CanvasState {
	path?: string;
	exists?: boolean;
	differs: boolean;
	threads?: string[] | null;
	changes?: string[] | null;
}


/** The chord a canvas path shows, or null: chords/<title>.canvas. */
export function chordOfCanvas(path: string): string | null {
	const m = /^chords\/([^/]+)\.canvas$/.exec(path);
	return m ? m[1] : null;
}

/** One short line for a canvas against its stubs: the threads that move, at most two by name. */
export function canvasSummary(s: CanvasState): string {
	if (!s.differs) return "Saved";
	const names = s.threads ?? [];
	const n = names.length;
	if (n === 0) return "Not saved";
	const shown = names.slice(0, 2).join(", ");
	return `${plural(n, "thread moves", "threads move")}: ${shown}${n > 2 ? `, +${n - 2}` : ""}`;
}
