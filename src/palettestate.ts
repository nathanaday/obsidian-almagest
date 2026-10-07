// What the tool palette shows, from the JSON of the binary. Pure: the tests cover it.

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
	/** The errors of the quick lint that status runs. */
	problems: number;
}

/** The palette's status. liveSessions comes from the sessions pane's rule, which checks the processes. */
export function paletteState(status: VaultStatus, liveSessions: number): PaletteState {
	const byTitle = (a: Ref, b: Ref) => a.title.localeCompare(b.title);
	return {
		proposed: [...(status.changes?.proposed ?? [])].sort(byTitle),
		running: [...(status.changes?.running ?? [])].sort(byTitle),
		ingest: (status.ingest ?? []).map((i) => i.name),
		pending: status.pending?.length ?? 0,
		sessions: liveSessions,
		trash: status.trash ?? 0,
		problems: status.problems ?? 0,
	};
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
	| { kind: "linked"; path: string; title: string; backlinks: Ref[] }
	| { kind: "error"; line: string };

/** What safe delete did: the file moved to trash/, or the documents that link it and keep it. */
export function trashOutcome(r: TrashResult): TrashOutcome {
	const backlinks = r.backlinks ?? [];
	if (backlinks.length > 0) return { kind: "linked", path: r.path, title: noteTitle(r.path), backlinks };
	if (!r.moved) return { kind: "error", line: `${r.path} did not move, and nothing links it.` };
	const through = r.change?.title ? ` The change ${r.change.title} records it.` : "";
	return { kind: "moved", line: `Moved ${r.path} to ${r.moved}.${through}` };
}
