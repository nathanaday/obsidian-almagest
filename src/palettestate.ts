// What the tool palette shows, from the JSON of the binary. Pure: the tests cover it.

import { Checkout, checkouts, toReturn } from "./checkoutstate";
import { JournalVolume, journalVolumes, toPublish } from "./journalstate";
import { isDocumentPath } from "./helpers";

/** A document as the binary refers to it (vault.Ref). */
export interface Ref {
	id?: string;
	type?: string;
	kind?: string;
	title: string;
	path: string;
	status?: string;
}

/** The parts of `vault --json` the palette reads. */
export interface VaultStatus {
	ingest?: { name: string }[] | null;
	pending?: Ref[] | null;
	changes?: { proposed?: Ref[] | null; running?: Ref[] | null } | null;
	trash?: number;
	journals?: Partial<JournalVolume>[] | null;
	checkouts?: Partial<Checkout>[] | null;
	problems?: number;
}

export interface PaletteState {
	proposed: Ref[];
	running: Ref[];
	/** The file names waiting in ingest/. */
	ingest: string[];
	pending: number;
	sessions: number;
	trash: number;
	journals: JournalVolume[];
	/** The volumes with changes to publish. */
	toPublish: number;
	/** The checkouts, newest first. */
	checkouts: Checkout[];
	/** The checkouts with edited copies to return. */
	toReturn: number;
	/** The errors of the quick lint that status runs. */
	problems: number;
}

/** The palette's status. liveSessions comes from the sessions pane's rule, which checks the processes. */
export function paletteState(status: VaultStatus, liveSessions: number): PaletteState {
	const byTitle = (a: Ref, b: Ref) => a.title.localeCompare(b.title);
	const journals = journalVolumes(status.journals);
	const list = checkouts(status.checkouts);
	return {
		proposed: [...(status.changes?.proposed ?? [])].sort(byTitle),
		running: [...(status.changes?.running ?? [])].sort(byTitle),
		ingest: (status.ingest ?? []).map((i) => i.name),
		pending: status.pending?.length ?? 0,
		sessions: liveSessions,
		trash: status.trash ?? 0,
		journals,
		toPublish: toPublish(journals),
		checkouts: list,
		toReturn: toReturn(list),
		problems: status.problems ?? 0,
	};
}

// The home of the palette: one row per area, each with a line and a count.

/** The areas of the palette, in the order its home lists them. */
export const AREAS = ["changes", "ingest", "health", "journals", "library", "agents", "note"] as const;
export type Area = (typeof AREAS)[number];

/** What a count chip means: something for the user to do, a problem, or a plain number. */
export type Tone = "accent" | "warning" | "muted";

/** One row of the palette's home: its name, the line under it, and its chip. */
export interface AreaLine {
	name: string;
	line: string;
	/** The chip's number; no chip when 0. */
	count: number;
	tone: Tone;
}

/**
 * The home row of an area. agents is the count of the agents the palette started that
 * still work; hasNote is whether a note is open.
 */
export function areaLine(area: Area, s: PaletteState, agents: number, hasNote: boolean): AreaLine {
	switch (area) {
		case "changes": {
			const parts = [s.proposed.length > 0 ? `${s.proposed.length} to review` : "", s.running.length > 0 ? `${s.running.length} running` : ""].filter((p) => p);
			return { name: "Changes", line: parts.join(" · ") || "Nothing to review", count: s.proposed.length, tone: "accent" };
		}
		case "ingest": {
			const parts = [s.ingest.length > 0 ? `${plural(s.ingest.length, "file", "files")} waiting` : "", s.pending > 0 ? `${plural(s.pending, "source", "sources")} to absorb` : ""].filter((p) => p);
			return { name: "Ingest", line: parts.join(" · ") || "Drop files in ingest/", count: s.ingest.length, tone: "accent" };
		}
		case "health":
			return { name: "Wiki health", line: s.problems > 0 ? plural(s.problems, "error", "errors") : "No errors", count: s.problems, tone: "warning" };
		case "journals": {
			const n = s.journals.length;
			const line = n === 0 ? "Your own writing" : s.toPublish > 0 ? `${s.toPublish} to publish` : `${plural(n, "volume", "volumes")}, all published`;
			return { name: "Journals", line, count: s.toPublish, tone: "accent" };
		}
		case "library": {
			const n = s.checkouts.length;
			const line = n === 0 ? "Gather the pages on a subject" : s.toReturn > 0 ? `${s.toReturn} to return` : plural(n, "checkout", "checkouts");
			return { name: "Library", line, count: s.toReturn, tone: "accent" };
		}
		case "agents": {
			const parts = [agents > 0 ? `${agents} working` : "", plural(s.sessions, "live session", "live sessions")];
			return { name: "Agents", line: parts.filter((p) => p).join(" · "), count: agents, tone: "muted" };
		}
		case "note":
			return { name: "This note", line: hasNote ? "Wikify it, or delete it safely" : "Open a note first", count: 0, tone: "muted" };
	}
}

export function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** The title Obsidian links a file by: a note's name without .md, any other file's full name. */
export function noteTitle(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return name.endsWith(".md") ? name.slice(0, -3) : name;
}

// Wiki lint

export interface LintFinding {
	check: string;
	severity: string;
	doc: Ref;
	message: string;
	fix: string;
}

/** What `lint --json` prints. */
export interface LintResult {
	findings?: LintFinding[] | null;
	counts?: Record<string, number> | null;
	checked?: number;
}

export interface LintSummary {
	/** "2 errors, 1 warning", or the line for a clean wiki. */
	counts: string;
	/** The first findings, the most severe first. */
	first: LintFinding[];
	/** The findings left out of first. */
	more: number;
	/** The errors and warnings that a change repairs. */
	repairable: number;
}

const SEVERITY = ["error", "warning", "info"];

/** Whether a change repairs a finding: an error or a warning whose fix is wiki-edit's. */
export function isRepairable(f: LintFinding): boolean {
	return (f.severity === "error" || f.severity === "warning") && /\bwiki-edit\b/.test(f.fix);
}

export function lintSummary(r: LintResult, max = 8): LintSummary {
	const findings = r.findings ?? [];
	const rank = (s: string) => (SEVERITY.includes(s) ? SEVERITY.indexOf(s) : SEVERITY.length);
	const sorted = [...findings].sort((a, b) => rank(a.severity) - rank(b.severity));
	const n = (s: string) => r.counts?.[s] ?? findings.filter((f) => f.severity === s).length;
	const parts = [plural(n("error"), "error", "errors"), plural(n("warning"), "warning", "warnings"), `${n("info")} info`].filter((p) => !p.startsWith("0 "));
	const checked = r.checked ?? 0;
	return {
		counts: parts.length > 0 ? parts.join(", ") : `No findings in ${plural(checked, "document", "documents")}.`,
		first: sorted.slice(0, max),
		more: Math.max(0, sorted.length - max),
		repairable: findings.filter(isRepairable).length,
	};
}

// Safe delete

/** What `vault trash --json` prints under "trash". */
export interface TrashResult {
	path: string;
	backlinks?: Ref[] | null;
	moved?: string;
	change?: Ref | null;
}

export type TrashOutcome =
	| { kind: "moved"; line: string }
	| { kind: "linked"; path: string; title: string; backlinks: Ref[]; yours: Ref[]; agent: boolean }
	| { kind: "error"; line: string };

/**
 * What safe delete did: the file moved to trash/, or the files that link it and keep it.
 * A link outside the knowledge documents is the user's to fix: an agent edits documents
 * only, and removes only a document. So an agent resolves a document that documents link.
 */
export function trashOutcome(r: TrashResult): TrashOutcome {
	const backlinks = r.backlinks ?? [];
	if (backlinks.length > 0) {
		const yours = backlinks.filter((b) => !isDocumentPath(b.path));
		const agent = isDocumentPath(r.path) && yours.length < backlinks.length;
		return { kind: "linked", path: r.path, title: noteTitle(r.path), backlinks, yours, agent };
	}
	if (!r.moved) return { kind: "error", line: `${r.path} did not move, and nothing links it.` };
	const through = r.change?.title ? ` The change ${r.change.title} records it.` : "";
	return { kind: "moved", line: `Moved ${r.path} to ${r.moved}.${through}` };
}
