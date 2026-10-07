import assert from "node:assert/strict";
import { test } from "node:test";
import { areaLine, AREAS, isRepairable, lintSummary, noteTitle, paletteState, trashOutcome } from "../src/palettestate";

const ref = (title: string, path: string, extra: Record<string, unknown> = {}) => ({ id: `id-${title}`, type: "change", title, path, tags: [], ...extra });

test("the palette's status comes from vault --json", () => {
	// The shape vault --json prints under "status", trimmed.
	const status = {
		vault: { id: "vlt-1", name: "T" },
		ingest: [
			{ name: "a.md", size: "6 B", kind: "markdown" },
			{ name: "b c.txt", size: "2 B", kind: "text" },
		],
		pending: [ref("Paper", "tool/source-core/documents/Paper.md", { type: "source" })],
		changes: {
			proposed: [ref("2026-10-06 Add B", "changes/2026-10/2026-10-06 Add B.md"), ref("2026-10-05 Add A", "changes/2026-10/2026-10-05 Add A.md")],
			running: [ref("2026-10-06 Ingest 2 files", "changes/2026-10/2026-10-06 Ingest 2 files.md", { kind: "ingest", status: "running" })],
			recent: [],
		},
		sessions: { running: [ref("s", "tool/sessions/s.md")], waiting: [], idle: [] },
		trash: 3,
		journals: [
			{ volume: "cs566-notes", name: "CS566 Notes", notes: 2, edition: "", changed: true },
			{ volume: "garden", name: "Garden", notes: 4, edition: "User Journal Garden - 5 October 2026 Edition", changed: false },
		],
		checkouts: [
			{ folder: "tool/returned/2026-10-05 Bandits", request: "bandits", date: "2026-10-05", documents: 4, edited: 1, status: "returned" as const, returned: "2026-10-05T17:00:00" },
			{ folder: "checkout/2026-10-06 RL", request: "reinforcement learning", date: "2026-10-06", documents: 7, edited: 2, returned: "" },
		],
		problems: 2,
	};
	const s = paletteState(status, { open: 1, waiting: 0 });
	assert.deepEqual(s.ingest, ["a.md", "b c.txt"]);
	assert.deepEqual(s.proposed.map((r) => r.title), ["2026-10-05 Add A", "2026-10-06 Add B"]);
	assert.equal(s.running[0]?.kind, "ingest");
	assert.equal(s.pending, 1);
	assert.equal(s.sessions, 1);
	assert.equal(s.trash, 3);
	assert.deepEqual(s.journals.map((v) => [v.volume, v.changed]), [["cs566-notes", true], ["garden", false]]);
	assert.equal(s.toPublish, 1);
	// The palette lists the checkouts out; the returned ones count for the ledger.
	assert.deepEqual(s.checkouts.map((c) => [c.request, c.edited, c.status]), [["reinforcement learning", 2, "out"]]);
	assert.equal(s.returned, 1);
	assert.equal(s.toReturn, 1);
	assert.equal(s.problems, 2);
});

test("an empty or older status reads as zeros", () => {
	const s = paletteState({ ingest: null, pending: null, changes: { proposed: null } }, { open: 0, waiting: 0 });
	assert.deepEqual(s, { proposed: [], running: [], ingest: [], pending: 0, sessions: 0, waiting: 0, trash: 0, journals: [], toPublish: 0, checkouts: [], returned: 0, toReturn: 0, problems: 0 });
	assert.deepEqual(paletteState({ journals: null }, { open: 0, waiting: 0 }).journals, []);
	assert.deepEqual(paletteState({ checkouts: null }, { open: 0, waiting: 0 }).checkouts, []);
	assert.deepEqual(paletteState({}, { open: 2, waiting: 1 }).sessions, 2);
	assert.deepEqual(paletteState({}, { open: 2, waiting: 1 }).waiting, 1);
});

test("noteTitle is the name Obsidian links a file by", () => {
	assert.equal(noteTitle("tool/source-core/documents/Beta.md"), "Beta");
	assert.equal(noteTitle("tool/source-core/originals/paper.pdf"), "paper.pdf");
	assert.equal(noteTitle("Top.md"), "Top");
});

const finding = (severity: string, check: string, fix: string, title = "Alpha") => ({
	check,
	severity,
	fix,
	message: `${check} in ${title}`,
	doc: { title, path: `tool/source-core/documents/${title}.md` },
});

test("lint shows its counts, the most severe findings first, and what a change repairs", () => {
	const r = {
		findings: [
			finding("info", "pending", "wiki-sync"),
			finding("warning", "orphan", "wiki-edit: link it from a related topic, tag it, or remove it"),
			finding("error", "dead-link", "wiki-edit (a change): create the document, or change the link"),
			finding("error", "dead-link", "vault sync: create the document, or change the link", "2026-10-06 Add A"),
			finding("warning", "stale", "wiki-review, then wiki-edit (a modify, or a confirm)"),
		],
		counts: { error: 2, warning: 2, info: 1 },
		checked: 9,
	};
	const s = lintSummary(r, 3);
	assert.equal(s.counts, "2 errors, 2 warnings, 1 info");
	assert.deepEqual(s.first.map((f) => f.severity), ["error", "error", "warning"]);
	assert.equal(s.more, 2);
	assert.equal(s.repairable, 3);
});

test("a clean lint says so, and offers no repair", () => {
	const s = lintSummary({ findings: [], counts: { error: 0, warning: 0, info: 0 }, checked: 1 });
	assert.equal(s.counts, "No findings in 1 document.");
	assert.equal(s.repairable, 0);
	assert.equal(lintSummary({ findings: null, checked: 4 }).counts, "No findings in 4 documents.");
	assert.equal(lintSummary({ findings: [finding("info", "tag-near", "wiki-edit: a retag merges them")] }).counts, "1 info");
});

test("isRepairable takes errors and warnings that wiki-edit fixes", () => {
	assert.ok(isRepairable(finding("error", "dead-link", "wiki-edit (a change): create the document, or change the link")));
	assert.ok(!isRepairable(finding("error", "dead-link", "vault sync: create the document, or change the link")));
	assert.ok(!isRepairable(finding("info", "tag-near", "wiki-edit: a retag merges them")));
	assert.ok(!isRepairable(finding("error", "schema", "your edit")));
	assert.ok(!isRepairable(finding("error", "repository-path", "repo-link with the new path, or repo-unlink")));
});

test("safe delete of a file that nothing links: it moved to tool/trash/", () => {
	assert.deepEqual(trashOutcome({ path: "scratchpad/n.md", backlinks: [], moved: "tool/trash/2026-10-06/scratchpad/n.md" }), {
		kind: "moved",
		line: "Moved scratchpad/n.md to tool/trash/2026-10-06/scratchpad/n.md.",
	});
	const viaChange = trashOutcome({
		path: "tool/source-core/documents/Beta.md",
		backlinks: [],
		moved: "tool/trash/2026-10-06/source-core/documents/Beta.md",
		change: ref("2026-10-06 Delete Beta", "changes/2026-10/2026-10-06 Delete Beta.md"),
	});
	assert.equal(viaChange.kind, "moved");
	assert.match((viaChange as { line: string }).line, /The change 2026-10-06 Delete Beta records it\.$/);
});

test("safe delete of a file that others link: it stays, with its backlinks", () => {
	const alpha = ref("Alpha", "tool/source-core/documents/Alpha.md", { type: "topic" });
	const out = trashOutcome({ path: "tool/source-core/documents/Beta.md", backlinks: [alpha], moved: "" });
	assert.deepEqual(out, { kind: "linked", path: "tool/source-core/documents/Beta.md", title: "Beta", backlinks: [alpha], yours: [], agent: true });
});

test("a link outside the knowledge documents is the user's, and an agent resolves only a document that documents link", () => {
	const alpha = ref("Alpha", "tool/source-core/documents/Alpha.md", { type: "topic" });
	const week = ref("Week 1", "journals/cs566/Week 1.md");
	const copy = ref("Beta (checkout)", "checkout/2026-10-06 Study/Beta (checkout).md");
	const mixed = trashOutcome({ path: "tool/source-core/documents/Beta.md", backlinks: [alpha, week, copy], moved: "" });
	assert.ok(mixed.kind === "linked" && mixed.agent);
	assert.deepEqual((mixed as { yours: unknown }).yours, [week, copy]);
	const onlyYours = trashOutcome({ path: "tool/source-core/documents/Beta.md", backlinks: [week], moved: "" });
	assert.ok(onlyYours.kind === "linked" && !onlyYours.agent);
	const aNote = trashOutcome({ path: "scratchpad/Plan.md", backlinks: [alpha], moved: "" });
	assert.ok(aNote.kind === "linked" && !aNote.agent && aNote.yours.length === 0);
});

test("safe delete that neither moved nor found a backlink is an error", () => {
	assert.equal(trashOutcome({ path: "x.md", backlinks: null, moved: "" }).kind, "error");
});

test("the palette's home names each area's state in one line, with a chip only when it counts", () => {
	const empty = paletteState({}, { open: 0, waiting: 0 });
	const lines = AREAS.map((a) => areaLine(a, empty, 0, false));
	assert.deepEqual(
		lines.map((l) => [l.name, l.line, l.count]),
		[
			["Changes", "Nothing to review", 0],
			["Ingest", "Drop files in ingest/", 0],
			["Wiki health", "No errors", 0],
			["Journals", "Your own writing", 0],
			["Library", "Gather the pages on a subject", 0],
			["Agents", "0 live sessions", 0],
			["This note", "Open a note first", 0],
		],
	);
	const busy = paletteState(
		{
			ingest: [{ name: "a.pdf" }, { name: "b.md" }],
			pending: [ref("Paper", "tool/source-core/documents/Paper.md")],
			changes: { proposed: [ref("Add A", "changes/a.md")], running: [ref("Ingest", "changes/i.md"), ref("Repair", "changes/r.md")] },
			problems: 3,
			journals: [{ volume: "cs566", name: "CS566", notes: 2, changed: true }],
			checkouts: [{ folder: "checkout/2026-10-06 RL", edited: 1 }],
		},
		{ open: 1, waiting: 0 },
	);
	assert.deepEqual(areaLine("changes", busy, 0, true), { name: "Changes", line: "1 to review · 2 running", count: 1, tone: "accent" });
	assert.deepEqual(areaLine("ingest", busy, 0, true), { name: "Ingest", line: "2 files waiting · 1 source to absorb", count: 2, tone: "accent" });
	assert.deepEqual(areaLine("health", busy, 0, true), { name: "Wiki health", line: "3 errors", count: 3, tone: "warning" });
	assert.equal(areaLine("journals", busy, 0, true).line, "1 to publish");
	assert.deepEqual(areaLine("library", busy, 0, true), { name: "Library", line: "1 out · 1 with edits", count: 1, tone: "accent" });
	assert.deepEqual(areaLine("agents", busy, 2, true), { name: "Agents", line: "2 working · 1 live session", count: 2, tone: "muted" });
	// A session that waits for the user outranks the agents that work: its count is the user's to act on.
	const waiting = paletteState({}, { open: 3, waiting: 2 });
	assert.deepEqual(areaLine("agents", waiting, 1, true), { name: "Agents", line: "2 need you · 1 working · 3 live sessions", count: 2, tone: "accent" });
	assert.equal(areaLine("agents", paletteState({}, { open: 1, waiting: 1 }), 0, true).line, "1 needs you · 1 live session");
	assert.equal(areaLine("note", busy, 0, true).line, "Wikify it, or delete it safely");
});
