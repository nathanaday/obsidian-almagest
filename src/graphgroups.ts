// Pure functions: no Obsidian, no Node. The tests cover them.

import { asList, linkTitle } from "./helpers";

export type GraphMode = "off" | "tag" | "type" | "work" | "activity";

export const GRAPH_MODES: { mode: GraphMode; label: string }[] = [
	{ mode: "off", label: "Off" },
	{ mode: "tag", label: "Tag" },
	{ mode: "type", label: "Type" },
	{ mode: "work", label: "Work" },
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
	paths: string[];
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

const WORK_TYPES = ["stub", "spec"];

const TYPE_GROUPS: { name: string; test: (fields: Record<string, unknown>) => boolean }[] = [
	{ name: "Sources", test: (f) => f.type === "source" },
	{ name: "Repositories", test: (f) => f.type === "repository" },
	{ name: "Concepts", test: (f) => f.type === "topic" && f.kind === "concept" },
	{ name: "Entities", test: (f) => f.type === "topic" && f.kind === "entity" },
	{ name: "Policies", test: (f) => f.type === "topic" && f.kind === "policy" },
	{ name: "Overviews", test: (f) => f.type === "topic" && f.kind === "overview" },
	{ name: "Stubs and specs", test: (f) => f.type === "stub" || f.type === "spec" },
	{ name: "Events", test: (f) => f.type === "event" },
];

const QUARTERS = ["Newest 25%", "25–50%", "50–75%", "Oldest 25%"];

/** The groups of a mode, in the order the graph applies them. Empty groups are left out. */
export function graphGroups(mode: GraphMode, docs: GraphDoc[], resolve: Resolve, theme: Theme): Group[] {
	const vault = new Vault(docs, resolve);
	let groups: Group[];
	switch (mode) {
		case "tag":
			groups = vault.byTag(theme);
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

/** The top part of the first tag a field list holds, or null. */
function topTag(fields: Record<string, unknown>): string | null {
	const list = asList(fields.tags);
	if (typeof fields.defines === "string" && fields.defines) list.push(fields.defines);
	const first = list.map((t) => t.trim().replace(/^#/, "").toLowerCase()).find((t) => t !== "");
	return first ? first.split("/")[0] : null;
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
		const own = topTag(doc.fields);
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
				return via("specs") ?? via("work");
			case "change":
				return via("absorbs") ?? via("work");
		}
		return null;
	}

	byTag(theme: Theme): Group[] {
		const members = new Map<string, string[]>();
		const first = new Map<string, string>();
		for (const d of this.docs) {
			const tag = this.tagOf(d);
			if (tag === null) continue;
			members.set(tag, [...(members.get(tag) ?? []), d.path]);
			const created = String(d.fields.created ?? "9999");
			if (!first.has(tag) || created < (first.get(tag) ?? "")) first.set(tag, created);
		}
		// The tags held first keep the first colors, so a new tag never repaints the others.
		const order = [...members.keys()].sort((a, b) => (first.get(a) ?? "").localeCompare(first.get(b) ?? "") || a.localeCompare(b));
		const palette = CATEGORICAL[theme];
		const groups = order.slice(0, palette.length).map((tag, i) => ({ name: "#" + tag, color: palette[i], paths: members.get(tag) ?? [] }));
		const rest = order.slice(palette.length).flatMap((tag) => members.get(tag) ?? []);
		if (rest.length > 0) groups.push({ name: "Other tags", color: MUTED, paths: rest });
		return groups;
	}

	byType(theme: Theme): Group[] {
		const palette = CATEGORICAL[theme];
		const groups = TYPE_GROUPS.map((g, i) => ({
			name: g.name,
			color: palette[i],
			paths: this.docs.filter((d) => g.test(d.fields)).map((d) => d.path),
		}));
		groups.push({ name: "Sessions and changes", color: MUTED, paths: this.docs.filter((d) => this.type(d.path) === "session" || this.type(d.path) === "change").map((d) => d.path) });
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
			{ name: "Open work", color: palette[1], paths: open },
			{ name: "Done work", color: palette[0], paths: done },
			{ name: "No work", color: MUTED, paths: none },
		];
	}

	/** A stub's or a plan's own state, or null for any other document. */
	private stateOf(path: string): string | null {
		const d = this.byPath.get(path);
		if (!d) return null;
		const t = this.type(path);
		if (t === "stub" || (t === "spec" && d.fields.kind === "plan")) {
			const s = String(d.fields.status ?? "open");
			return s === "done" || s === "dropped" || s === "resolved" ? "done" : "open";
		}
		return null;
	}

	/**
	 * The states of the work a document belongs to or shares a link with. A stub or a plan
	 * takes only its own state; an event takes its subject's.
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
			if (!WORK_TYPES.includes(this.type(p))) continue;
			const s = this.stateOf(p);
			if (s) states.add(s);
		}
		return states;
	}
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
		query: pathQuery(g.paths),
		color: { a: 1, rgb: parseInt(g.color.slice(1), 16) },
	}));
}

/** Whether Atlas wrote a group: only pathQuery gives this form. */
export function isAtlasQuery(query: string): boolean {
	return query.startsWith("path:/^(?:") && query.endsWith(")$/");
}

/**
 * The graph's groups with ours first, since the first group that matches a node colors
 * it. The user's own groups stay after ours.
 */
export function mergeColorGroups(current: ColorGroup[], ours: ColorGroup[]): ColorGroup[] {
	return [...ours, ...current.filter((g) => !isAtlasQuery(g.query))];
}
