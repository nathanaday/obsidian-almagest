import assert from "node:assert/strict";
import { test } from "node:test";
import {
	LAYOUT,
	MIGRATES_FROM,
	SNAPSHOT_QUIET_DEFAULT,
	layoutName,
	asList,
	binaryCandidates,
	chooseBinary,
	countsLine,
	errorMessage,
	expandTags,
	groupDocs,
	holds,
	isDocumentPath,
	isDocumentType,
	isLockHeld,
	isSnapshotPath,
	isWatchedPath,
	layoutOf,
	migrationSteps,
	migrationSummary,
	narrow,
	normalTag,
	quietSeconds,
	relativeTag,
	repoBlock,
	searchURI,
	tagViewPath,
	TagDoc,
	topTags,
	formatAgo,
	lastProgressLine,
	linkTitle,
	movedNotices,
	strayNotices,
	syncSummary,
	syncedPaths,
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

test("small labels", () => {
	assert.ok(isWatchedPath("source-core/documents/Filter.md"));
	assert.ok(!isWatchedPath("wiki-view/View · Home.md"), "a view change never starts a sync");
	assert.ok(!isWatchedPath(".obsidian/app.json"));
	assert.ok(!isWatchedPath("source-core/originals/a.png"));
	assert.equal(waitingLabel(1), "Atlas: 1 session waits");
	assert.equal(waitingLabel(2), "Atlas: 2 sessions wait");
	assert.equal(layoutOf({ layout: 3 }), 3);
	assert.equal(layoutOf({ layout: "2" }), 2);
	assert.equal(layoutOf(undefined), 0);
	assert.deepEqual(repoBlock(" doc-abc123 · ~/src/p3-edge \n"), { id: "doc-abc123", path: "~/src/p3-edge" });
});

test("layout 6 is 10.0, and the binary migrates from 8.x and 9.0", () => {
	assert.equal(LAYOUT, 6);
	assert.equal(MIGRATES_FROM, 4);
	assert.deepEqual(
		[layoutName(7), layoutName(6), layoutName(5), layoutName(4), layoutName(3), layoutName(2), layoutName(0)],
		["10.0", "10.0", "9.0", "8.x", "7.x", "6.x", "6.x"],
	);
});

test("the folders of layout 10", () => {
	assert.ok(isDocumentPath("source-core/documents/Lidar.md"));
	assert.ok(!isDocumentPath("source-core/originals/Lidar.pdf"));
	assert.ok(!isDocumentPath("wiki/documents/Lidar.md"));
	assert.equal(tagViewPath("work/p3"), "wiki-view/nav/work/p3/Tag · work › p3.md");
});

test("a quiet snapshot counts every event outside the config folder and wiki-view/", () => {
	assert.ok(isSnapshotPath("source-core/documents/Lidar.md", ".obsidian"));
	assert.ok(isSnapshotPath("scratchpad/idea.md", ".obsidian"));
	assert.ok(isSnapshotPath("ingest/paper.pdf", ".obsidian"));
	assert.ok(isSnapshotPath(".obsidian-notes.md", ".obsidian"), "only the folder itself is left out");
	assert.ok(!isSnapshotPath(".obsidian/workspace.json", ".obsidian"));
	assert.ok(!isSnapshotPath(".config/app.json", ".config"));
	assert.ok(!isSnapshotPath("wiki-view/View · Home.md", ".obsidian"));
	assert.ok(!isSnapshotPath("wiki-view/nav/ml/Tag · ml.md", ".obsidian"));
	assert.ok(!isSnapshotPath("", ".obsidian"));
});

test("a held lock is told apart from other failures", () => {
	assert.ok(isLockHeld("another atlas write holds /v/.git/atlas.lock; try again"));
	assert.ok(isLockHeld("another atlas write in this process holds the lock of /v; try again"));
	assert.ok(!isLockHeld("vault takes migrate, sync, or init, not \"snapshot\""));
	assert.ok(!isLockHeld("the atlas-obsidian binary was not found at /x"));
});

test("quietSeconds reads the setting and the field", () => {
	assert.equal(SNAPSHOT_QUIET_DEFAULT, 120);
	assert.equal(quietSeconds(undefined), 120);
	assert.equal(quietSeconds(""), 120);
	assert.equal(quietSeconds(" 45 "), 45);
	assert.equal(quietSeconds(0), 0, "0 turns snapshots off");
	assert.equal(quietSeconds("0"), 0);
	assert.equal(quietSeconds(-5), 0);
	assert.equal(quietSeconds(2.6), 3);
	assert.equal(quietSeconds("ten"), 120);
	assert.equal(quietSeconds(true), 120);
	assert.equal(quietSeconds(1e12), 86_400, "a timer longer than a day overflows");
});

test("the migration lists the 10.0 moves, and the 9.0 step for an 8.x vault", () => {
	const from9 = migrationSteps(5);
	assert.ok(from9.some((s) => s.includes("wiki/documents/ to source-core/documents/")));
	assert.ok(from9.some((s) => s.includes("wiki/assets/ to source-core/originals/")));
	assert.ok(from9.some((s) => s.includes("inbox/ to ingest/")));
	assert.ok(from9.some((s) => s.includes("wiki-view/nav/")));
	assert.ok(!from9.some((s) => s.includes("threads/")));
	const from8 = migrationSteps(4);
	assert.ok(from8[0].includes("threads/"));
	assert.equal(from8.length, from9.length + 1);
});

test("migrationSummary", () => {
	assert.equal(
		migrationSummary({ vault: "Work", commit: "0123456789abcdef", moved: [{ from: "inbox/a.pdf", to: "ingest/a.pdf" }], edited: ["x.md", "y.md"], problems: 1, plugin: "10.0.0" }),
		"Migrated to the 10.0 layout in one commit, 0123456. 1 file moved, 2 edited. Lint finds 1 error. The Obsidian plugin is now 10.0.0; reload Obsidian to use it.",
	);
	assert.equal(migrationSummary({ vault: "Work", commit: "abcdef0123", moved: [], edited: null, problems: 0 }), "Migrated to the 10.0 layout in one commit, abcdef0.");
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
	return { path: `source-core/documents/${title}.md`, title, type, kind, status, description: "", tags };
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

test("a sync that moved a note out of wiki-view/ says where it went", () => {
	const s = { strays: [{ from: "wiki-view/Draft.md", to: "ingest/Draft.md" }], skipped: ["source-core/documents/Paper.md"] };
	assert.deepEqual(strayNotices(s), ["Moved wiki-view/Draft.md to ingest/Draft.md: code writes every file in wiki-view/, so your note waits in ingest/."]);
	assert.equal(syncSummary(s), "Synced 1 document left as saved.");
	assert.deepEqual(syncedPaths(s), ["wiki-view/Draft.md", "ingest/Draft.md"]);
	assert.deepEqual(strayNotices({}), []);
});

test("any result that moved a note out of wiki-view/ says where it went", () => {
	assert.deepEqual(movedNotices({ commit: "abc", moved_from_wiki_view: [{ from: "wiki-view/Plan.md", to: "ingest/Plan.md" }] }), [
		"Moved wiki-view/Plan.md to ingest/Plan.md: code writes every file in wiki-view/, so your note waits in ingest/.",
	]);
	assert.deepEqual(movedNotices({ commit: "abc" }), []);
	assert.deepEqual(movedNotices({ moved_from_views: [{ from: "views/Plan.md", to: "inbox/Plan.md" }] }), [], "the 9.0 key is gone");
	assert.deepEqual(movedNotices(null), []);
	assert.deepEqual(movedNotices({ moved_from_wiki_view: [{ from: 1 }] }), []);
});

test("the navigator lists every document type and nothing else", () => {
	for (const type of ["source", "repository", "topic"]) assert.ok(isDocumentType(type), type);
	for (const type of ["stub", "chord", "event", "session", "change", undefined]) assert.ok(!isDocumentType(type), String(type));
});
