// The change widget's state, from the frontmatter of the note that holds the block. Pure:
// the tests cover it.

import { countsLine } from "./helpers";

/** What the atlas-change block shows. */
export interface ChangeCard {
	/** The change's status, "busy" while a button's command runs, or "none" outside a change document. */
	state: string;
	label: string;
	line: string;
	counts: string;
	/** A work document's kind and files: "ingest · 2 files"; "" for any other change. */
	kind: string;
	id: string;
	buttons: ChangeButton[];
}

export type ChangeButton = "approve" | "cancel";

/** The command a widget runs, while it runs. */
export type ChangeAction = "apply" | "reject";

const RESULT: Record<string, (fm: Record<string, unknown>) => string> = {
	applying: () => "Being applied. If this stays, the apply stopped; the next Atlas write puts the documents back and sets the change to proposed.",
	applied: (fm) => {
		const when = stampText(fm.applied);
		return when ? `Applied ${when}.` : "Applied.";
	},
	rejected: (fm) => {
		const reason = typeof fm.reason === "string" ? fm.reason.trim() : "";
		return reason ? `Rejected: ${reason}` : "Rejected.";
	},
	superseded: () => "A later change replaced this one.",
	undone: () => "Undone. The documents are back as they were before it.",
};

/**
 * The card for a change document's frontmatter. A command that runs for this change
 * (busy) takes the place of its status until the frontmatter changes. progress is the
 * last line of the document's Progress section.
 */
export function changeCard(fm: Record<string, unknown> | null | undefined, busy: ChangeAction | null = null, progress = ""): ChangeCard {
	if (!fm || fm.type !== "change") {
		return { state: "none", label: "Change", line: "This block shows a change. This note is not a change document.", counts: "", kind: "", id: "", buttons: [] };
	}
	const id = typeof fm.id === "string" ? fm.id.trim() : "";
	const status = typeof fm.status === "string" ? fm.status.trim() : "";
	const counts = countsLine(fm.counts);
	const card = { id, counts, kind: workKind(fm) };
	if (busy === "apply") return { ...card, state: "busy", label: "Applying", line: "Atlas applies this change.", buttons: [] };
	if (busy === "reject") return { ...card, state: "busy", label: "Cancelling", line: "Atlas rejects this change.", buttons: [] };
	if (status === "proposed") {
		if (!id) return { ...card, state: "proposed", label: "Proposed", line: "This change has no id, so it cannot be applied from here.", buttons: [] };
		return {
			...card,
			state: "proposed",
			label: "Proposed",
			line: "Review the writes below. Approve applies them in one commit. Cancel rejects the change, and this document stays as the record.",
			buttons: ["approve", "cancel"],
		};
	}
	if (status === "running") {
		const line = progress.trim() || "The agent starts. Its steps appear here and under Progress.";
		return { ...card, state: "running", label: "Running", line, buttons: id ? ["cancel"] : [] };
	}
	const result = RESULT[status];
	if (result) return { ...card, state: status, label: capital(status), line: result(fm), buttons: [] };
	return { ...card, state: "other", label: status ? capital(status) : "Change", line: status ? `Status: ${status}.` : "This change has no status.", buttons: [] };
}

/** "ingest · 2 files", "repair", or "" for a change that is no work document. */
export function workKind(fm: Record<string, unknown>): string {
	const kind = typeof fm.kind === "string" ? fm.kind.trim() : "";
	if (!kind) return "";
	const files = Array.isArray(fm.files) ? fm.files.length : 0;
	return files > 0 ? `${kind} · ${files} ${files === 1 ? "file" : "files"}` : kind;
}

/** The reason that change reject records: one line, and a default when the user gave none. */
export function rejectReason(input: string): string {
	const line = input.replace(/\s+/g, " ").trim();
	return line || "cancelled in Obsidian";
}

/** "2026-10-06T14:03:05" as "2026-10-06 14:03"; "" when it does not look like a stamp. */
export function stampText(value: unknown): string {
	const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(String(value ?? ""));
	return m ? `${m[1]} ${m[2]}` : "";
}

function capital(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
