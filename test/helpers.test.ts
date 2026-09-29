import assert from "node:assert/strict";
import { test } from "node:test";
import {
	appleScriptString,
	asList,
	binaryCandidates,
	chooseBinary,
	companionRename,
	compareSessions,
	countsLine,
	cssString,
	errorMessage,
	folderPagePath,
	formatAgo,
	isFolderPage,
	isThreadPath,
	lastProgressLine,
	linkTitle,
	mentionRanges,
	resumeCommand,
	shellQuote,
	syncSummary,
	syncedPaths,
	terminalArgs,
	textMentions,
	waitingLabel,
} from "../src/helpers";

test("chooseBinary prefers the setting, then the first place that exists", () => {
	const home = "/Users/a";
	const found = binaryCandidates(home);
	assert.equal(found[0], "/Users/a/.atlas/bin/atlas-obsidian");
	assert.equal(chooseBinary("~/bin/atlas-obsidian", found, () => false, home), "/Users/a/bin/atlas-obsidian");
	assert.equal(chooseBinary("  ", found, (p) => p === "/Users/a/go/bin/atlas-obsidian", home), "/Users/a/go/bin/atlas-obsidian");
	assert.ok(!found.some((p) => p.startsWith("/usr/")), "the system folders are left out");
	assert.equal(chooseBinary("", found, () => true, home), "/Users/a/.atlas/bin/atlas-obsidian");
	assert.equal(chooseBinary("", found, () => false, home), null);
});

test("errorMessage takes the atlas line of stderr", () => {
	assert.equal(errorMessage("warning\natlas: reject needs the reason, in one line\n"), "reject needs the reason, in one line");
	assert.equal(errorMessage("panic: boom\n"), "panic: boom");
	assert.equal(errorMessage(""), "");
});

test("syncSummary says what changed in one line", () => {
	assert.equal(syncSummary({ threads: [], lost: null, sessions: [], settings: false }), "Nothing to heal.");
	assert.equal(
		syncSummary({ threads: ["a", "b"], lost: ["c"], sessions: null, settings: true }),
		"Synced 2 thread documents, 1 lost session, the harness settings.",
	);
	assert.deepEqual(syncedPaths({ threads: ["a"], lost: null, sessions: ["s"] }), ["a", "s"]);
});

test("countsLine drops the zeros from a string or an object", () => {
	assert.equal(countsLine("3 create, 1 modify, 0 rename, 0 remove, 2 link rewrites"), "3 create, 1 modify, 2 link rewrites");
	assert.equal(countsLine({ create: 0, modify: 2, rename: 0, remove: 1, link_rewrites: 10 }), "2 modify, 1 remove, 10 link rewrites");
	assert.equal(countsLine(undefined), "");
});

test("formatAgo", () => {
	const now = new Date(2026, 8, 27, 15, 10, 0);
	assert.equal(formatAgo("2026-09-27T15:09:30", now), "just now");
	assert.equal(formatAgo("2026-09-27T15:07:00", now), "3 min ago");
	assert.equal(formatAgo("2026-09-27T12:00:00", now), "3 h ago");
	assert.equal(formatAgo("2026-09-26T12:00:00", now), "1 day ago");
	assert.equal(formatAgo("2026-09-20T12:00:00", now), "7 days ago");
	assert.equal(formatAgo("not a time", now), "");
	assert.equal(formatAgo(undefined, now), "");
});

test("linkTitle and asList", () => {
	assert.equal(linkTitle("[[Filter vehicle false alarms]]"), "Filter vehicle false alarms");
	assert.equal(linkTitle("[[Title|shown]]"), "Title");
	assert.equal(linkTitle("[[Title#Progress]]"), "Title");
	assert.equal(linkTitle("Plain"), "Plain");
	assert.equal(linkTitle(3), "");
	assert.deepEqual(asList("[[A]]"), ["[[A]]"]);
	assert.deepEqual(asList(["[[A]]", 2, "[[B]]"]), ["[[A]]", "[[B]]"]);
	assert.deepEqual(asList(null), []);
});

test("lastProgressLine reads only the Progress section", () => {
	const doc = [
		"> [!task] Add the filter",
		"",
		"## Progress",
		"",
		"- 2026-09-26 Wrote the test.",
		"- 2026-09-27 The filter passes.",
		"",
		"## Notes",
		"- not progress",
	].join("\n");
	assert.equal(lastProgressLine(doc), "2026-09-27 The filter passes.");
	assert.equal(lastProgressLine("## Plan\n- a"), "");
});

test("compareSessions puts waiting first, then the newest", () => {
	const rows = [
		{ status: "running", updated: "2026-09-27T10:00:00" },
		{ status: "waiting", updated: "2026-09-27T09:00:00" },
		{ status: "running", updated: "2026-09-27T11:00:00" },
	].sort(compareSessions);
	assert.deepEqual(
		rows.map((r) => r.updated),
		["2026-09-27T09:00:00", "2026-09-27T11:00:00", "2026-09-27T10:00:00"],
	);
});

test("resumeCommand quotes the folder and the id", () => {
	const home = "/Users/a";
	assert.equal(
		resumeCommand({ harness: "claude", harness_id: "abc-1", cwd: "~/work/it's here" }, home),
		`cd '/Users/a/work/it'\\''s here' && claude --resume 'abc-1'`,
	);
	assert.equal(resumeCommand({ harness: "codex", harness_id: "x", cwd: "/w" }, home), `cd '/w' && codex resume 'x'`);
	assert.equal(resumeCommand({ harness: "claude", harness_id: "x" }, home), `claude --resume 'x'`);
	assert.equal(resumeCommand({ harness: "claude", harness_id: "" }, home), null);
});

test("terminalArgs escapes the command for AppleScript", () => {
	assert.equal(shellQuote("a'b"), `'a'\\''b'`);
	assert.equal(appleScriptString(`say "hi" \\ bye`), `"say \\"hi\\" \\\\ bye"`);
	const args = terminalArgs(`cd '/a "b"' && claude --resume 'x'`);
	assert.equal(args[0], "-e");
	assert.equal(args[1], `tell application "Terminal" to do script "cd '/a \\"b\\"' && claude --resume 'x'"`);
});

test("mentionRanges marks @atlas in task lines only", () => {
	assert.deepEqual(mentionRanges("- [ ] @atlas add these papers"), [[6, 12]]);
	assert.deepEqual(mentionRanges("  * [x] ask @atlas and @atlas."), [[12, 18], [23, 29]]);
	assert.deepEqual(mentionRanges("1. [ ] @atlas"), [[7, 13]]);
	assert.deepEqual(mentionRanges("@atlas in a paragraph"), []);
	assert.deepEqual(mentionRanges("- a list item @atlas"), []);
	assert.deepEqual(textMentions("mail me@atlas.dev or @atlasx or @atlas-obsidian"), []);
});

test("small labels", () => {
	assert.ok(isThreadPath("threads/Filter/Filter.md"));
	assert.ok(!isThreadPath("threads/board.base"));
	assert.ok(!isThreadPath("wiki/threads/x.md"));
	assert.equal(waitingLabel(1), "Atlas: 1 session waits");
	assert.equal(waitingLabel(2), "Atlas: 2 sessions wait");
});

test("a scope folder and its page follow each other's rename", () => {
	assert.equal(folderPagePath("wiki/ML/CS566"), "wiki/ML/CS566/CS566.md");
	assert.equal(folderPagePath("threads/X"), null);
	assert.ok(isFolderPage("wiki/ML/CS566/CS566.md"));
	assert.ok(!isFolderPage("wiki/ML/CS566/concepts/Backprop.md"));
	assert.deepEqual(companionRename(true, "wiki/ML/CS566 DL", "wiki/ML/CS566"), { from: "wiki/ML/CS566 DL/CS566.md", to: "wiki/ML/CS566 DL/CS566 DL.md" });
	assert.equal(companionRename(true, "wiki/Other/CS566", "wiki/ML/CS566"), null, "a moved folder keeps its name");
	assert.deepEqual(companionRename(false, "wiki/ML/CS566/CS566 DL.md", "wiki/ML/CS566/CS566.md"), { from: "wiki/ML/CS566", to: "wiki/ML/CS566 DL" });
	assert.equal(companionRename(false, "wiki/ML/CS566 DL/CS566 DL.md", "wiki/ML/CS566 DL/CS566.md"), null, "the page caught up with its folder");
	assert.equal(companionRename(false, "wiki/ML/CS566/concepts/B.md", "wiki/ML/CS566/concepts/A.md"), null);
	assert.equal(companionRename(false, "wiki/ML/CS566.md", "wiki/ML/CS566/CS566.md"), null, "a page moved out of its folder");
	assert.equal(cssString('wiki/a "b"\\c'), '"wiki/a \\"b\\"\\\\c"');
});
