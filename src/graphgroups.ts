// Pure functions: no Obsidian, no Node. The tests cover them.

import { asList, linkTitle } from "./helpers";

export type GraphMode = "off" | "area" | "type" | "threads" | "activity";

export const GRAPH_MODES: { mode: GraphMode; label: string }[] = [
	{ mode: "off", label: "Off" },
	{ mode: "area", label: "Area" },
	{ mode: "type", label: "Type" },
	{ mode: "threads", label: "Threads" },
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

const THREAD_TYPES = ["stub", "spec", "task", "receipt"];

const TYPE_GROUPS: { name: string; types: string[] }[] = [
	{ name: "Areas", types: ["area"] },
	{ name: "Repositories", types: ["repository"] },
	{ name: "Concepts", types: ["concept"] },
	{ name: "Entities", types: ["entity"] },
	{ name: "Policies", types: ["policy"] },
	{ name: "Sources", types: ["source"] },
	{ name: "Threads", types: THREAD_TYPES },
	{ name: "Sessions and changes", types: ["session", "change"] },
];

const QUARTERS = ["Newest 25%", "25–50%", "50–75%", "Oldest 25%"];

/** The groups of a mode, in the order the graph applies them. Empty groups are left out. */
export function graphGroups(mode: GraphMode, docs: GraphDoc[], resolve: Resolve, theme: Theme): Group[] {
	const vault = new Vault(docs, resolve);
	let groups: Group[];
	switch (mode) {
		case "area":
			groups = vault.byArea(theme);
			break;
		case "type":
			groups = vault.byType(theme);
			break;
		case "threads":
			groups = vault.byThreads(theme);
			break;
		case "activity":
			groups = byActivity(docs, theme);
			break;
		default:
			groups = [];
	}
	return groups.filter((g) => g.paths.length > 0);
}

class Vault {
	private byPath = new Map<string, GraphDoc>();
	private backlinks = new Map<string, string[]>();
	private areas = new Map<string, string | null>();

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

	byArea(theme: Theme): Group[] {
		const members = new Map<string, string[]>();
		for (const d of this.docs) {
			const area = this.areaOf(d.path);
			if (area === null) continue;
			members.set(area, [...(members.get(area) ?? []), d.path]);
		}
		// The oldest areas keep the first colors, so a new area never repaints the others.
		const order = [...members.keys()].sort((a, b) => {
			const ca = String(this.byPath.get(a)?.fields.created ?? "");
			const cb = String(this.byPath.get(b)?.fields.created ?? "");
			return ca.localeCompare(cb) || basename(a).localeCompare(basename(b));
		});
		const palette = CATEGORICAL[theme];
		const groups = order.slice(0, palette.length).map((area, i) => ({
			name: basename(area),
			color: palette[i],
			paths: members.get(area) ?? [],
		}));
		const rest = order.slice(palette.length).flatMap((area) => members.get(area) ?? []);
		if (rest.length > 0) groups.push({ name: "Other areas", color: MUTED, paths: rest });
		return groups;
	}

	/** The nearest area of a document: the area it is about, or the area of its scope or thread. */
	areaOf(path: string, seen = new Set<string>()): string | null {
		if (this.areas.has(path)) return this.areas.get(path) ?? null;
		if (seen.has(path)) return null;
		seen.add(path);
		const area = this.findArea(path, seen);
		this.areas.set(path, area);
		return area;
	}

	private findArea(path: string, seen: Set<string>): string | null {
		const doc = this.byPath.get(path);
		if (!doc) return null;
		const first = (paths: string[]) => {
			for (const p of paths) {
				const a = this.areaOf(p, seen);
				if (a !== null) return a;
			}
			return null;
		};
		switch (this.type(path)) {
			case "area":
				return path;
			case "repository":
			case "concept":
			case "entity":
			case "policy":
			case "source": {
				// The chain runs from the top down; the last area in it is the nearest.
				const chain = this.links(doc, "chain").filter((p) => this.type(p) === "area");
				if (chain.length > 0) return chain[chain.length - 1];
				return first([...this.links(doc, "parent"), ...this.links(doc, "scope")]);
			}
			case "stub":
				return first(this.links(doc, "scope"));
			case "spec":
			case "task":
			case "receipt":
			case "change":
				return first(this.links(doc, "thread"));
			case "session":
				return first([...this.links(doc, "threads"), ...this.links(doc, "repositories")]);
		}
		return null;
	}

	byType(theme: Theme): Group[] {
		const palette = CATEGORICAL[theme];
		return TYPE_GROUPS.map((g, i) => ({
			name: g.name,
			color: palette[i],
			paths: this.docs.filter((d) => g.types.includes(this.type(d.path))).map((d) => d.path),
		}));
	}

	byThreads(theme: Theme): Group[] {
		const open: string[] = [];
		const closed: string[] = [];
		const none: string[] = [];
		for (const d of this.docs) {
			const states = this.threadStates(d);
			if (states.has("open")) open.push(d.path);
			else if (states.has("closed")) closed.push(d.path);
			else none.push(d.path);
		}
		const palette = CATEGORICAL[theme];
		return [
			{ name: "Open threads", color: palette[1], paths: open },
			{ name: "Closed threads", color: palette[0], paths: closed },
			{ name: "No threads", color: MUTED, paths: none },
		];
	}

	/** The stubs a document belongs to. */
	private threadsOf(doc: GraphDoc): string[] {
		switch (this.type(doc.path)) {
			case "stub":
				return [doc.path];
			case "spec":
			case "task":
			case "receipt":
			case "change":
				return this.links(doc, "thread");
			case "session":
				return this.links(doc, "threads");
		}
		return [];
	}

	/**
	 * The states of the threads a document belongs to or shares a link with. A thread
	 * document takes only its own thread's state.
	 */
	private threadStates(doc: GraphDoc): Set<string> {
		const stubs = new Set(this.threadsOf(doc));
		if (!THREAD_TYPES.includes(this.type(doc.path))) {
			const near = [...doc.links, ...(this.backlinks.get(doc.path) ?? [])];
			for (const p of near) {
				const other = this.byPath.get(p);
				if (other && THREAD_TYPES.includes(this.type(p))) this.threadsOf(other).forEach((s) => stubs.add(s));
			}
		}
		const states = new Set<string>();
		for (const s of stubs) {
			if (this.type(s) !== "stub") continue;
			states.add(this.byPath.get(s)?.fields.stage === "closed" ? "closed" : "open");
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

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
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
