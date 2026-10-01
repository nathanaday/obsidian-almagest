// Pure functions: no Obsidian, no Node. The tests cover them.

import { asList, holds, linkTitle, normalTag } from "./helpers";

export type GraphMode = "off" | "tag" | "focus" | "type" | "work" | "activity";

export const GRAPH_MODES: { mode: GraphMode; label: string }[] = [
	{ mode: "off", label: "Off" },
	{ mode: "tag", label: "Tag" },
	{ mode: "focus", label: "Focus" },
	{ mode: "type", label: "Type" },
	{ mode: "work", label: "Threads" },
	{ mode: "activity", label: "Activity" },
];

export function isGraphMode(value: unknown): value is GraphMode {
	return GRAPH_MODES.some((m) => m.mode === value);
}

export type Theme = "light" | "dark";

/** One markdown file of the vault, as the graph sees it. */
export interface GraphDoc {
	path: string;
	fields: Record<string, unknown>;
	/** Modification time in milliseconds. */
	mtime: number;
	/** The paths this file links to, frontmatter links included. */
	links: string[];
}

/** The path a link from a file names, or null. */
export type Resolve = (link: string, from: string) => string | null;

export interface Group {
	name: string;
	/** "#rrggbb" */
	color: string;
	/** The documents the group colors, for the legend; the query decides in the graph. */
	paths: string[];
	/** The graph query; without one, the group names its paths. */
	query?: string;
}

/** A color group as Obsidian's graph keeps it. */
export interface ColorGroup {
	query: string;
	color: { a: number; rgb: number };
}

// The categorical order of the dataviz reference palette, light and dark steps.
const CATEGORICAL: Record<Theme, string[]> = {
	light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
	dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};
// Newest first: the most recent quarter stands out most against the background.
const RECENCY: Record<Theme, string[]> = {
	light: ["#104281", "#256abf", "#5598e7", "#9ec5f4"],
	dark: ["#b7d3f6", "#6da7ec", "#2a78d6", "#1c5cab"],
};
const MUTED = "#898781";

const THREAD_TYPES = ["stub", "spec", "tasks", "verification", "chord"];
const THREAD_PARTS = ["spec", "tasks", "verification"];

// Obsidian matches a property's name as a substring, so [type:spec] also reads an event's
// to_type. Events come first: the first group that matches colors a node.
const TYPE_GROUPS: { name: string; query: string; test: (fields: Record<string, unknown>) => boolean }[] = [
	{ name: "Events", query: "[type:event]", test: (f) => f.type === "event" },
	{ name: "Sources", query: "[type:source]", test: (f) => f.type === "source" },
	{ name: "Repositories", query: "[type:repository]", test: (f) => f.type === "repository" },
	{ name: "Concepts", query: "[type:topic] [kind:concept]", test: (f) => f.type === "topic" && f.kind === "concept" },
	{ name: "Entities", query: "[type:topic] [kind:entity]", test: (f) => f.type === "topic" && f.kind === "entity" },
	{ name: "Policies", query: "[type:topic] [kind:policy]", test: (f) => f.type === "topic" && f.kind === "policy" },
	{ name: "Overviews", query: "[type:topic] [kind:overview]", test: (f) => f.type === "topic" && f.kind === "overview" },
	{
		name: "Threads and chords",
		query: THREAD_TYPES.map((t) => `[type:${t}]`).join(" OR "),
		test: (f) => THREAD_TYPES.includes(String(f.type)),
	},
];


const QUARTERS = ["Newest 25%", "25–50%", "50–75%", "Oldest 25%"];

/** The groups of a mode, in the order the graph applies them. Empty groups are left out. */
export function graphGroups(mode: GraphMode, docs: GraphDoc[], resolve: Resolve, theme: Theme, focus: string[] = []): Group[] {
	const vault = new Vault(docs, resolve);
	let groups: Group[];
	switch (mode) {
		case "tag":
			groups = vault.byTag(theme);
			break;
		case "focus":
			groups = byFocus(docs, focus, theme);
			break;
		case "type":
			groups = vault.byType(theme);
			break;
		case "work":
			groups = vault.byWork(theme);
			break;
		case "activity":
			groups = byActivity(docs, theme);
			break;
		default:
			groups = [];
	}
	return groups.filter((g) => g.paths.length > 0);
}

/** Every tag a document holds, the one it defines included. */
function tagsOf(fields: Record<string, unknown>): string[] {
	const list = asList(fields.tags);
	if (typeof fields.defines === "string" && fields.defines) list.push(fields.defines);
	return list.map(normalTag).filter((t) => t !== "");
}

/** The top parts of a document's tags, in the order it holds them. */
function topTags(fields: Record<string, unknown>): string[] {
	return [...new Set(tagsOf(fields).map((t) => t.split("/")[0]))];
}

/**
 * The graph query of the documents that hold a tag or a tag below it, or define one.
 * Obsidian matches a property's value as a substring, so defines takes a regex.
 */
export function tagQuery(tag: string): string {
	return `tag:#${tag} OR [defines:/^${tag}(\\/|$)/]`;
}

/** A query that matches the documents holding every one of these tags. */
export function allTagsQuery(tags: string[]): string {
	return tags.length === 1 ? tagQuery(tags[0]) : tags.map((t) => `(${tagQuery(t)})`).join(" ");
}

class Vault {
	private byPath = new Map<string, GraphDoc>();
	private backlinks = new Map<string, string[]>();

	constructor(private docs: GraphDoc[], private resolve: Resolve) {
		for (const d of docs) this.byPath.set(d.path, d);
		for (const d of docs) {
			for (const to of d.links) {
				const from = this.backlinks.get(to) ?? [];
				from.push(d.path);
				this.backlinks.set(to, from);
			}
		}
	}

	private type(path: string | null): string {
		const t = path === null ? undefined : this.byPath.get(path)?.fields.type;
		return typeof t === "string" ? t : "";
	}

	private links(doc: GraphDoc, field: string): string[] {
		return asList(doc.fields[field])
			.map((l) => this.resolve(linkTitle(l), doc.path))
			.filter((p): p is string => p !== null && this.byPath.has(p));
	}

	/** The top tag a document belongs to: its own; an event's subject's; a session's or a change's first document's. */
	tagOf(doc: GraphDoc, depth = 0): string | null {
		if (depth > 3) return null;
		const own = topTags(doc.fields)[0];
		if (own) return own;
		const via = (field: string) => {
			for (const p of this.links(doc, field)) {
				const t = this.tagOf(this.byPath.get(p)!, depth + 1);
				if (t) return t;
			}
			return null;
		};
		switch (this.type(doc.path)) {
			case "event":
				return via("subject");
			case "session":
				return via("threads") ?? via("specs") ?? via("work");
			case "change":
				return via("absorbs") ?? via("work");
		}
		return null;
	}

	/**
	 * A group per top tag of the typed documents, at most eight: the tags held first take
	 * the first colors, so a new tag never repaints the others, and of two tags held first
	 * on one day, the one more documents hold. The graph colors a node by the first group
	 * that matches, so the legend counts each document in the first group whose tag it
	 * holds. Sessions and changes hold no tags: each joins the group of the work it touched,
	 * by its path. A tag past the eighth, and a note with no type, get no group.
	 */
	byTag(theme: Theme): Group[] {
		const typed = this.docs.filter((d) => this.type(d.path) !== "");
		const first = new Map<string, string>();
		const count = new Map<string, number>();
		for (const d of typed) {
			const created = String(d.fields.created ?? "9999").slice(0, 10);
			for (const t of topTags(d.fields)) {
				if (!first.has(t) || created < (first.get(t) ?? "")) first.set(t, created);
				count.set(t, (count.get(t) ?? 0) + 1);
			}
		}
		const order = [...first.keys()].sort(
			(a, b) => (first.get(a) ?? "").localeCompare(first.get(b) ?? "") || (count.get(b) ?? 0) - (count.get(a) ?? 0) || a.localeCompare(b),
		);
		const palette = CATEGORICAL[theme];
		const groups = order.slice(0, palette.length).map((t, i) => ({ name: "#" + t, color: palette[i], tag: t, paths: [] as string[], records: [] as string[] }));
		for (const d of typed) {
			const own = topTags(d.fields);
			if (own.length > 0) {
				groups.find((g) => own.includes(g.tag))?.paths.push(d.path);
				continue;
			}
			const type = this.type(d.path);
			if (type !== "session" && type !== "change") continue;
			const g = groups.find((x) => x.tag === this.tagOf(d));
			if (g) {
				g.paths.push(d.path);
				g.records.push(d.path);
			}
		}
		return groups.map((g) => ({
			name: g.name,
			color: g.color,
			paths: g.paths,
			query: [tagQuery(g.tag), ...g.records.sort().map((p) => `path:"${p}"`)].join(" OR "),
		}));
	}

	byType(theme: Theme): Group[] {
		const palette = CATEGORICAL[theme];
		const groups: Group[] = TYPE_GROUPS.map((g, i) => ({
			name: g.name,
			color: palette[i],
			paths: this.docs.filter((d) => g.test(d.fields)).map((d) => d.path),
			query: g.query,
		}));
		groups.push({
			name: "Sessions and changes",
			color: MUTED,
			paths: this.docs.filter((d) => this.type(d.path) === "session" || this.type(d.path) === "change").map((d) => d.path),
			query: "[type:session] OR [type:change]",
		});
		return groups;
	}

	byWork(theme: Theme): Group[] {
		const open: string[] = [];
		const done: string[] = [];
		const none: string[] = [];
		for (const d of this.docs) {
			const states = this.workStates(d);
			if (states.has("open")) open.push(d.path);
			else if (states.has("done")) done.push(d.path);
			else none.push(d.path);
		}
		const palette = CATEGORICAL[theme];
		return [
			{ name: "Open threads", color: palette[1], paths: open },
			{ name: "Ended threads", color: palette[0], paths: done },
			{ name: "No thread", color: MUTED, paths: none },
		];
	}

	/**
	 * The state of a thread or a chord: open, or done when it is closed, dropped, or
	 * resolved. A spec, a task list, and a verification take their thread's. Null for any
	 * other document.
	 */
	private stateOf(path: string): string | null {
		const d = this.byPath.get(path);
		if (!d) return null;
		const t = this.type(path);
		if (t === "stub" || t === "chord") {
			const s = String(d.fields.status ?? "");
			return s === "closed" || s === "dropped" || s === "resolved" ? "done" : "open";
		}
		if (THREAD_PARTS.includes(t)) {
			for (const p of this.links(d, "thread")) {
				if (this.type(p) === "stub") return this.stateOf(p);
			}
		}
		return null;
	}

	/**
	 * The states of the threads a document belongs to or shares a link with. A thread
	 * document takes only its own state; an event takes its subject's.
	 */
	private workStates(doc: GraphDoc): Set<string> {
		const states = new Set<string>();
		const own = this.stateOf(doc.path);
		if (own) {
			states.add(own);
			return states;
		}
		if (this.type(doc.path) === "event") {
			for (const p of this.links(doc, "subject")) {
				const s = this.stateOf(p);
				if (s) states.add(s);
			}
			return states;
		}
		const near = [...doc.links, ...(this.backlinks.get(doc.path) ?? [])];
		for (const p of near) {
			if (!THREAD_TYPES.includes(this.type(p))) continue;
			const s = this.stateOf(p);
			if (s) states.add(s);
		}
		return states;
	}
}

/**
 * The tags chosen in the Atlas navigator: one group, the documents that hold every one
 * of them. The rest stay uncolored, so the overlap stands out in a large graph.
 */
function byFocus(docs: GraphDoc[], chosen: string[], theme: Theme): Group[] {
	const tags = [...new Set(chosen.map(normalTag).filter((t) => t !== ""))];
	if (tags.length === 0) return [];
	return [
		{
			name: tags.map((t) => "#" + t).join(" + "),
			color: CATEGORICAL[theme][0],
			paths: docs.filter((d) => tags.every((t) => holds(tagsOf(d.fields), t))).map((d) => d.path),
			query: allTagsQuery(tags),
		},
	];
}

/** Quarters by the day of the last update, then by the modification time. */
function byActivity(docs: GraphDoc[], theme: Theme): Group[] {
	const key = (d: GraphDoc) => {
		const updated = String(d.fields.updated ?? "").slice(0, 10);
		return /^\d{4}-\d{2}-\d{2}$/.test(updated) ? updated : localDate(d.mtime);
	};
	const sorted = [...docs].sort((a, b) => key(b).localeCompare(key(a)) || b.mtime - a.mtime);
	const groups = QUARTERS.map((name, i) => ({ name, color: RECENCY[theme][i], paths: [] as string[] }));
	sorted.forEach((d, i) => groups[Math.floor((i * 4) / sorted.length)].paths.push(d.path));
	return groups;
}

function localDate(ms: number): string {
	const t = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** A graph query that matches exactly these paths. */
export function pathQuery(paths: string[]): string {
	const alternatives = paths.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\//g, "\\/"));
	return `path:/^(?:${alternatives.join("|")})$/`;
}

export function colorGroups(groups: Group[]): ColorGroup[] {
	return groups.map((g) => ({
		query: g.query ?? pathQuery(g.paths),
		color: { a: 1, rgb: parseInt(g.color.slice(1), 16) },
	}));
}

/** Whether a query has the form only pathQuery gives. */
export function isAtlasQuery(query: string): boolean {
	return query.startsWith("path:/^(?:") && query.endsWith(")$/");
}

/**
 * The graph's groups with ours first, since the first group that matches a node colors
 * it. A group is ours when Atlas wrote its query before (`owned`), or when it names paths
 * the way only Atlas does; the user's own groups, and a group the user edited, stay after
 * ours.
 */
export function mergeColorGroups(current: ColorGroup[], ours: ColorGroup[], owned: string[] = []): ColorGroup[] {
	const mine = new Set([...owned, ...ours.map((g) => g.query)]);
	return [...ours, ...current.filter((g) => !isAtlasQuery(g.query) && !mine.has(g.query))];
}
