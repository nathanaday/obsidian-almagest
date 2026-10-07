import assert from "node:assert/strict";
import { test } from "node:test";
import { isRepairable, lintSummary, noteTitle, paletteState, trashOutcome } from "../src/palettestate";

const ref = (title: string, path: string, extra: Record<string, unknown> = {}) => ({ id: `id-${title}`, type: "change", title, path, tags: [], ...extra });

test("the palette's status comes from vault --json", () => {
	// The shape vault --json prints under "status", trimmed.
	const status = {
		vault: { id: "vlt-1", name: "T" },
		ingest: [
			{ name: "a.md", size: "6 B", kind: "markdown" },
			{ name: "b c.txt", size: "2 B", kind: "text" },
		],
		pending: [ref("Paper", "source-core/documents/Paper.md", { type: "source" })],
		changes: {
			proposed: [ref("2026-10-06 Add B", "changes/2026-10/2026-10-06 Add B.md"), ref("2026-10-05 Add A", "changes/2026-10/2026-10-05 Add A.md")],
			running: [ref("2026-10-06 Ingest 2 files", "changes/2026-10/2026-10-06 Ingest 2 files.md", { kind: "ingest", status: "running" })],
			recent: [],
		},
		sessions: { running: [ref("s", "sessions/s.md")], waiting: [], idle: [] },
		trash: 3,
		problems: 2,
	};
	const s = paletteState(status, 1);
	assert.deepEqual(s.ingest, ["a.md", "b c.txt"]);
	assert.deepEqual(s.proposed.map((r) => r.title), ["2026-10-05 Add A", "2026-10-06 Add B"]);
	assert.equal(s.running[0].kind, "ingest");
	assert.equal(s.pending, 1);
	assert.equal(s.sessions, 1);
	assert.equal(s.trash, 3);
	assert.equal(s.problems, 2);
});

test("an empty or older status reads as zeros", () => {
	const s = paletteState({ ingest: null, pending: null, changes: { proposed: null } }, 0);
	assert.deepEqual(s, { proposed: [], running: [], ingest: [], pending: 0, sessions: 0, trash: 0, problems: 0 });
	assert.deepEqual(paletteState({}, 2).sessions, 2);
});

test("noteTitle is the name Obsidian links a file by", () => {
	assert.equal(noteTitle("source-core/documents/Beta.md"), "Beta");
	assert.equal(noteTitle("source-core/originals/paper.pdf"), "paper.pdf");
	assert.equal(noteTitle("Top.md"), "Top");
});

const finding = (severity: string, check: string, fix: string, title = "Alpha") => ({
	check,
	severity,
	fix,
	message: `${check} in ${title}`,
	doc: { title, path: `source-core/documents/${title}.md` },
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

test("safe delete of a file that nothing links: it moved to trash/", () => {
	assert.deepEqual(trashOutcome({ path: "scratchpad/n.md", backlinks: [], moved: "trash/2026-10-06/scratchpad/n.md" }), {
		kind: "moved",
		line: "Moved scratchpad/n.md to trash/2026-10-06/scratchpad/n.md.",
	});
	const viaChange = trashOutcome({
		path: "source-core/documents/Beta.md",
		backlinks: [],
		moved: "trash/2026-10-06/source-core/documents/Beta.md",
		change: ref("2026-10-06 Delete Beta", "changes/2026-10/2026-10-06 Delete Beta.md"),
	});
	assert.equal(viaChange.kind, "moved");
	assert.match((viaChange as { line: string }).line, /The change 2026-10-06 Delete Beta records it\.$/);
});

test("safe delete of a file that others link: it stays, with its backlinks", () => {
	const backlinks = [ref("Alpha", "source-core/documents/Alpha.md", { type: "topic" })];
	const out = trashOutcome({ path: "source-core/documents/Beta.md", backlinks, moved: "" });
	assert.deepEqual(out, { kind: "linked", path: "source-core/documents/Beta.md", title: "Beta", backlinks });
});

test("safe delete that neither moved nor found a backlink is an error", () => {
	assert.equal(trashOutcome({ path: "x.md", backlinks: null, moved: "" }).kind, "error");
});
