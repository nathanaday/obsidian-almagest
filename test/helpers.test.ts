import assert from "node:assert/strict";
import { test } from "node:test";
import {
	LAYOUT,
	layoutName,
	asList,
	binaryCandidates,
	chooseBinary,
	countsLine,
	cssString,
	errorMessage,
	expandTags,
	groupDocs,
	holds,
	isDocumentType,
	isTagView,
	isWatchedPath,
	layoutOf,
	narrow,
	normalTag,
	relativeTag,
	repoBlock,
	searchURI,
	tagOfFolder,
	tagViewPath,
	TagDoc,
	topTags,
	formatAgo,
	lastProgressLine,
	linkTitle,
	mentionRanges,
	movedNotices,
	strayNotices,
	syncSummary,
	syncedPaths,
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
	assert.equal(syncSummary({ knowledge: [], lost: null, sessions: [], settings: false, views: 0 }), "Generated files are up to date.");
	assert.equal(
		syncSummary({ knowledge: ["k", "l"], moved: ["m"], lost: ["c"], sessions: null, settings: true, views: 3 }),
		"Synced 2 knowledge documents, 1 document moved back, 1 lost session, the harness settings, 3 views.",
	);
	assert.deepEqual(syncedPaths({ knowledge: ["k"], moved: ["m"], lost: null, sessions: ["s"] }), ["k", "m", "s"]);
});

test("countsLine drops the zeros from a string or an object", () => {
	assert.equal(countsLine("3 create, 1 modify, 0 rename, 0 remove, 2 link rewrites"), "3 create, 1 modify, 2 link rewrites");
	assert.equal(countsLine({ create: 0, modify: 2, rename: 0, remove: 1, link_rewrites: 10 }), "2 modify, 1 remove, 10 link rewrites");
	assert.equal(countsLine({ confirm: 1, retag: 1, tag_rewrites: 4 }), "1 confirm, 1 retag, 4 tag rewrites");
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

test("mentionRanges marks @atlas in task lines only", () => {
	assert.deepEqual(mentionRanges("- [ ] @atlas add these papers"), [[6, 12]]);
	assert.deepEqual(mentionRanges("  * [x] ask @atlas and @atlas."), [[12, 18], [23, 29]]);
	assert.deepEqual(mentionRanges("1. [ ] @atlas"), [[7, 13]]);
	assert.deepEqual(mentionRanges("@atlas in a paragraph"), []);
	assert.deepEqual(mentionRanges("- a list item @atlas"), []);
	assert.deepEqual(textMentions("mail me@atlas.dev or @atlasx or @atlas-obsidian"), []);
});

test("small labels", () => {
	assert.ok(isWatchedPath("wiki/documents/Filter.md"));
	assert.ok(!isWatchedPath("views/View · Home.md"), "a view change never starts a sync");
	assert.ok(!isWatchedPath(".obsidian/app.json"));
	assert.ok(!isWatchedPath("wiki/assets/a.png"));
	assert.equal(waitingLabel(1), "Atlas: 1 session waits");
	assert.equal(waitingLabel(2), "Atlas: 2 sessions wait");
	assert.equal(cssString('wiki/a "b"\\c'), '"wiki/a \\"b\\"\\\\c"');
	assert.equal(layoutOf({ layout: 3 }), 3);
	assert.equal(layoutOf({ layout: "2" }), 2);
	assert.equal(layoutOf(undefined), 0);
	assert.equal(LAYOUT, 5);
	assert.deepEqual([layoutName(5), layoutName(4), layoutName(3), layoutName(2), layoutName(0)], ["9.0", "8.x", "7.x", "6.x", "6.x"]);
	assert.deepEqual(repoBlock(" doc-abc123 · ~/src/p3-edge \n"), { id: "doc-abc123", path: "~/src/p3-edge" });
});

test("a tag's view lies in a folder per tag part", () => {
	assert.equal(tagViewPath("work/p3"), "views/tags/work/p3/Tag · work › p3.md");
	assert.ok(isTagView("views/tags/work/p3/Tag · work › p3.md"));
	assert.ok(!isTagView("views/tags/work/p3/Notes.md"));
	assert.ok(!isTagView("views/View · Home.md"));
	assert.equal(tagOfFolder("views/tags/work/p3"), "work/p3");
	assert.equal(tagOfFolder("views/tags/"), null);
	assert.equal(tagOfFolder("wiki/documents"), null);
});

test("a tag holds its children, and a list expands to every ancestor", () => {
	assert.equal(normalTag(" #Work/P3 "), "work/p3");
	assert.equal(relativeTag("ml/cs566/project", ["ml"]), "› cs566 › project");
	assert.equal(relativeTag("ml/cs566/project", ["ml", "ml/cs566"]), "› project");
	assert.equal(relativeTag("tool", ["ml"]), "#tool");
	assert.ok(holds(["work/p3/edge"], "work"));
	assert.ok(holds(["work/p3"], "work/p3"));
	assert.ok(!holds(["work/p3x"], "work/p3"));
	assert.deepEqual(expandTags(["work/p3/edge", "cs513"]).sort(), ["cs513", "work", "work/p3", "work/p3/edge"]);
});

function tdoc(title: string, type: string, tags: string[], kind = "", status = ""): TagDoc {
	return { path: `wiki/documents/${title}.md`, title, type, kind, status, description: "", tags };
}

test("narrow finds the documents at the intersection and the tags that occur with them", () => {
	const docs = [
		tdoc("Lidar", "topic", ["cs513", "self-driving"], "concept"),
		tdoc("Planner", "repository", ["cs513/project", "self-driving"]),
		tdoc("Planner paper", "source", ["cs513/project", "self-driving"], "", "absorbed"),
		tdoc("Homework", "topic", ["cs513"], "entity"),
		tdoc("Tesla", "source", ["self-driving"]),
		tdoc("Agents", "topic", ["cs513/project", "self-driving"], "overview"),
	];
	const { matches, with: facets } = narrow(docs, ["cs513", "self-driving"]);
	assert.deepEqual(matches.map((d) => d.title), ["Lidar", "Planner", "Planner paper", "Agents"]);
	assert.deepEqual(facets, [{ tag: "cs513/project", count: 3 }]);
	assert.deepEqual(topTags(docs), [
		{ tag: "self-driving", count: 5 },
		{ tag: "cs513", count: 5 },
	].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)));
	assert.deepEqual(
		groupDocs(matches).map((g) => [g.name, g.docs.map((d) => d.title)]),
		[
			["Topics", ["Agents", "Lidar"]],
			["Sources", ["Planner paper"]],
			["Repositories", ["Planner"]],
		],
		"topics first, each group by title",
	);
	assert.equal(searchURI("My Work", ["cs513", "self-driving"]), "obsidian://search?vault=My%20Work&query=tag%3A%23cs513%20tag%3A%23self-driving");
});

test("a sync that moved a note out of views/ says where it went", () => {
	const s = { strays: [{ from: "views/Draft.md", to: "inbox/Draft.md" }], skipped: ["wiki/documents/Paper.md"] };
	assert.deepEqual(strayNotices(s), ["Moved views/Draft.md to inbox/Draft.md: code writes every file in views/, so your note waits in the inbox."]);
	assert.equal(syncSummary(s), "Synced 1 document left as saved.");
	assert.deepEqual(syncedPaths(s), ["views/Draft.md", "inbox/Draft.md"]);
	assert.deepEqual(strayNotices({}), []);
});

test("any result that moved a note out of views/ says where it went", () => {
	assert.deepEqual(movedNotices({ commit: "abc", moved_from_views: [{ from: "views/Plan.md", to: "inbox/Plan.md" }] }), [
		"Moved views/Plan.md to inbox/Plan.md: code writes every file in views/, so your note waits in the inbox.",
	]);
	assert.deepEqual(movedNotices({ commit: "abc" }), []);
	assert.deepEqual(movedNotices(null), []);
	assert.deepEqual(movedNotices({ moved_from_views: [{ from: 1 }] }), []);
});

test("the navigator lists every document type and nothing else", () => {
	for (const type of ["source", "repository", "topic"]) assert.ok(isDocumentType(type), type);
	for (const type of ["stub", "chord", "event", "session", "change", undefined]) assert.ok(!isDocumentType(type), String(type));
});
