import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ColorGroup,
	GraphDoc,
	Resolve,
	colorGroups,
	graphGroups,
	allTagsQuery,
	isAtlasQuery,
	mergeColorGroups,
	pathQuery,
	tagQuery,
} from "../src/graphgroups";

function doc(path: string, fields: Record<string, unknown>, mtime = 0): GraphDoc {
	return { path, fields, mtime };
}

const vault: GraphDoc[] = [
	doc("wiki/documents/P3.md", { type: "topic", kind: "overview", created: "2026-01-01", defines: "work/p3" }),
	doc("wiki/documents/Lidar.md", { type: "topic", kind: "concept", created: "2026-02-01", tags: ["cs513", "self-driving"] }),
	doc("wiki/documents/p3-edge.md", { type: "repository", created: "2026-01-05", tags: ["work/p3"] }),
	doc("wiki/documents/Rules.md", { type: "topic", kind: "policy", created: "2026-03-01", tags: ["work"] }),
	doc("wiki/documents/Paper.md", { type: "source", created: "2026-02-10", tags: ["cs513"] }),
	doc("sessions/2026-09/s1.md", { type: "session", repositories: ["[[p3-edge]]"] }),
	doc("sessions/2026-09/s2.md", { type: "session", changes: ["[[c1]]"] }),
	doc("changes/2026-09/c1.md", { type: "change", absorbs: ["[[Paper]]"] }),
	doc("changes/2026-09/c2.md", { type: "change" }),
	doc("Notes.md", {}),
];

const resolve: Resolve = (link) => vault.find((d) => d.path.endsWith(`/${link}.md`) || d.path === `${link}.md`)?.path ?? null;

function names(groups: { name: string; paths: string[] }[]): Record<string, string[]> {
	return Object.fromEntries(groups.map((g) => [g.name, [...g.paths].sort()]));
}

test("tag mode: a query per top tag, oldest tag first; a session joins by its repository or its change, a change by what it absorbs", () => {
	const groups = graphGroups("tag", vault, resolve, "light");
	assert.deepEqual(groups.map((g) => g.name), ["#work", "#cs513"]);
	assert.deepEqual(names(groups), {
		"#work": ["sessions/2026-09/s1.md", "wiki/documents/P3.md", "wiki/documents/Rules.md", "wiki/documents/p3-edge.md"],
		"#cs513": ["changes/2026-09/c1.md", "sessions/2026-09/s2.md", "wiki/documents/Lidar.md", "wiki/documents/Paper.md"],
	});
	assert.equal(groups[0].query, 'tag:#work OR [defines:/^work(\\/|$)/] OR path:"sessions/2026-09/s1.md"');
	assert.equal(groups[1].query, 'tag:#cs513 OR [defines:/^cs513(\\/|$)/] OR path:"changes/2026-09/c1.md" OR path:"sessions/2026-09/s2.md"');
	assert.equal(groups[0].color, "#2a78d6");
	assert.equal(graphGroups("tag", vault, resolve, "dark")[0].color, "#3987e5");
});

test("tag mode colors eight tags; a tie on the day goes to the larger tag", () => {
	const docs = Array.from({ length: 10 }, (_, i) =>
		doc(`wiki/documents/T${i}.md`, { type: "topic", tags: [`t${i}`], created: `2026-01-${String(i + 1).padStart(2, "0")}` }),
	);
	const groups = graphGroups("tag", docs, () => null, "light");
	assert.equal(groups.length, 8);
	assert.ok(!groups.some((g) => g.paths.includes("wiki/documents/T8.md")), "a tag past the eighth gets no group");
	const tie = [
		doc("a.md", { type: "topic", tags: ["subject", "tool"], created: "2026-09-28T00:00:00" }),
		doc("b.md", { type: "topic", tags: ["subject"], created: "2026-09-28T00:00:00" }),
		doc("note.md", { tags: ["stray"] }),
	];
	assert.deepEqual(graphGroups("tag", tie, () => null, "light").map((g) => [g.name, g.paths.length]), [["#subject", 2]], "no group for a note with no type");
});

test("focus mode colors only the documents that hold every chosen tag", () => {
	const groups = graphGroups("focus", vault, resolve, "light", ["cs513", "#Self-driving"]);
	assert.deepEqual(
		groups.map((g) => [g.name, g.query, g.paths]),
		[["#cs513 + #self-driving", "(tag:#cs513 OR [defines:/^cs513(\\/|$)/]) (tag:#self-driving OR [defines:/^self-driving(\\/|$)/])", ["wiki/documents/Lidar.md"]]],
	);
	assert.equal(graphGroups("focus", vault, resolve, "light", ["work"])[0].paths.length, 3, "a tag holds the tags below it");
	assert.deepEqual(graphGroups("focus", vault, resolve, "light", []), []);
	assert.deepEqual(graphGroups("focus", vault, resolve, "light", ["cs513", "work"]), [], "no overlap, no group");
	assert.equal(allTagsQuery(["x"]), tagQuery("x"));
});

test("type mode splits topics by kind and leaves empty groups out", () => {
	const groups = names(graphGroups("type", vault, resolve, "light"));
	assert.deepEqual(Object.keys(groups), ["Sources", "Repositories", "Concepts", "Policies", "Overviews", "Sessions and changes"]);
	const queries = graphGroups("type", vault, resolve, "light").map((g) => g.query);
	assert.deepEqual(queries.slice(0, 3), ["[type:source]", "[type:repository]", "[type:topic] [kind:concept]"]);
	assert.deepEqual(groups["Sessions and changes"], ["changes/2026-09/c1.md", "changes/2026-09/c2.md", "sessions/2026-09/s1.md", "sessions/2026-09/s2.md"]);
});

test("activity mode splits by the day of the update, then the modification time", () => {
	const day = (d: number) => Date.UTC(2026, 8, d, 12);
	const docs = [
		doc("a.md", { updated: "2026-09-01" }, day(20)),
		doc("b.md", { updated: "2026-09-10" }, day(10)),
		doc("c.md", { updated: "2026-09-10" }, day(11)),
		doc("d.md", {}, day(5)),
		doc("e.md", { updated: "2026-09-12" }, day(1)),
		doc("f.md", {}, day(15)),
		doc("g.md", { updated: "not a date" }, day(2)),
		doc("h.md", {}, day(3)),
	];
	const groups = graphGroups("activity", docs, () => null, "light");
	assert.deepEqual(
		groups.map((g) => [g.name, g.paths]),
		[
			["Newest 25%", ["f.md", "e.md"]],
			["25–50%", ["c.md", "b.md"]],
			["50–75%", ["d.md", "h.md"]],
			["Oldest 25%", ["g.md", "a.md"]],
		],
	);
	assert.deepEqual(graphGroups("activity", docs.slice(0, 2), () => null, "light").map((g) => g.paths), [["b.md"], ["a.md"]]);
});

test("off mode has no groups", () => {
	assert.deepEqual(graphGroups("off", vault, resolve, "light"), []);
});

// Reads a query the way Obsidian's search tokenizer reads a regex after an operator.
function obsidianRegex(query: string): RegExp {
	const body = query.slice("path:/".length, -1);
	return new RegExp(body.replace(/\\\//g, "/"), "i");
}

test("pathQuery matches exactly its paths, whatever they hold", () => {
	const paths = ["Notes.md", "wiki/concepts/C++ (lang) [draft].md", "a/b $1 ^x.md"];
	const q = pathQuery(paths);
	assert.ok(isAtlasQuery(q));
	const re = obsidianRegex(q);
	for (const p of paths) assert.ok(re.test(p), p);
	assert.ok(!re.test("inbox/Notes.md"));
	assert.ok(!re.test("Notes.md.bak"));
	assert.ok(!re.test("wiki/concepts/C (lang) [draft].md"));
});

test("mergeColorGroups replaces our groups and keeps the user's after them", () => {
	const user: ColorGroup = { query: "tag:#todo", color: { a: 1, rgb: 1 } };
	const old = colorGroups([{ name: "x", color: "#000000", paths: ["x.md"] }]);
	const ours = colorGroups([{ name: "y", color: "#2a78d6", paths: ["y.md"] }]);
	assert.deepEqual(ours[0].color, { a: 1, rgb: 0x2a78d6 });
	assert.deepEqual(mergeColorGroups([...old, user], ours), [...ours, user]);
	assert.deepEqual(mergeColorGroups([...old, user], []), [user]);
	const lastTime: ColorGroup = { query: "tag:#gone OR [defines:gone]", color: { a: 1, rgb: 2 } };
	const edited: ColorGroup = { query: "tag:#gone", color: { a: 1, rgb: 3 } };
	assert.deepEqual(mergeColorGroups([lastTime, edited, user], ours, [lastTime.query]), [...ours, edited, user], "a query Atlas wrote goes; one the user edited stays");
	assert.deepEqual(colorGroups([{ name: "q", color: "#000001", paths: ["z.md"], query: "tag:#q" }])[0].query, "tag:#q");
});
