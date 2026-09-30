import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ColorGroup,
	GraphDoc,
	Resolve,
	colorGroups,
	graphGroups,
	isAtlasQuery,
	mergeColorGroups,
	pathQuery,
} from "../src/graphgroups";

function doc(path: string, fields: Record<string, unknown>, links: string[] = [], mtime = 0): GraphDoc {
	return { path, fields, links, mtime };
}

const vault: GraphDoc[] = [
	doc("wiki/documents/P3.md", { type: "topic", kind: "overview", created: "2026-01-01", defines: "work/p3" }),
	doc("wiki/documents/Lidar.md", { type: "topic", kind: "concept", created: "2026-02-01", tags: ["cs513", "self-driving"] }),
	doc("wiki/documents/p3-edge.md", { type: "repository", created: "2026-01-05", tags: ["work/p3"] }),
	doc("wiki/documents/Rules.md", { type: "topic", kind: "policy", created: "2026-03-01", tags: ["work"] }),
	doc("wiki/documents/Paper.md", { type: "source", created: "2026-02-10", tags: ["cs513"] }),
	doc("wiki/documents/Filter.md", { type: "spec", kind: "plan", status: "started", blocked: "data", tags: ["work/p3"] }, ["wiki/documents/p3-edge.md"]),
	doc("wiki/documents/Idea.md", { type: "stub", status: "resolved", tags: ["cs513"] }, ["wiki/documents/Lidar.md"]),
	doc("wiki/documents/Design.md", { type: "spec", kind: "design", tags: ["work/p3"] }),
	doc("wiki/documents/Filter · started.md", { type: "event", kind: "started", subject: "[[Filter]]" }, ["wiki/documents/Filter.md"]),
	doc("sessions/2026-09/s1.md", { type: "session", specs: ["[[Filter]]"] }),
	doc("changes/2026-09/c1.md", { type: "change" }),
	doc("Notes.md", {}, ["wiki/documents/Lidar.md"]),
];

const resolve: Resolve = (link) => vault.find((d) => d.path.endsWith(`/${link}.md`) || d.path === `${link}.md`)?.path ?? null;

function names(groups: { name: string; paths: string[] }[]): Record<string, string[]> {
	return Object.fromEntries(groups.map((g) => [g.name, [...g.paths].sort()]));
}

test("tag mode groups each document under the top part of its first tag, oldest tag first", () => {
	const groups = graphGroups("tag", vault, resolve, "light");
	assert.deepEqual(groups.map((g) => g.name), ["#work", "#cs513"]);
	assert.deepEqual(names(groups), {
		"#work": [
			"sessions/2026-09/s1.md",
			"wiki/documents/Design.md",
			"wiki/documents/Filter · started.md",
			"wiki/documents/Filter.md",
			"wiki/documents/P3.md",
			"wiki/documents/Rules.md",
			"wiki/documents/p3-edge.md",
		],
		"#cs513": ["wiki/documents/Idea.md", "wiki/documents/Lidar.md", "wiki/documents/Paper.md"],
	});
	assert.equal(groups[0].color, "#2a78d6");
	assert.equal(graphGroups("tag", vault, resolve, "dark")[0].color, "#3987e5");
});

test("tag mode folds the tags past the eighth into one muted group", () => {
	const docs = Array.from({ length: 10 }, (_, i) =>
		doc(`wiki/documents/T${i}.md`, { type: "topic", tags: [`t${i}`], created: `2026-01-${String(i + 1).padStart(2, "0")}` }),
	);
	const groups = graphGroups("tag", docs, () => null, "light");
	assert.equal(groups.length, 9);
	assert.deepEqual(groups[8], { name: "Other tags", color: "#898781", paths: ["wiki/documents/T8.md", "wiki/documents/T9.md"] });
	assert.equal(new Set(groups.slice(0, 8).map((g) => g.color)).size, 8);
});

test("type mode splits topics by kind and leaves empty groups out", () => {
	const groups = names(graphGroups("type", vault, resolve, "light"));
	assert.deepEqual(Object.keys(groups), ["Sources", "Repositories", "Concepts", "Policies", "Overviews", "Stubs and specs", "Events", "Sessions and changes"]);
	assert.equal(groups["Stubs and specs"].length, 3);
	assert.deepEqual(groups["Sessions and changes"], ["changes/2026-09/c1.md", "sessions/2026-09/s1.md"]);
});

test("work mode: started work is open, an event takes its subject's state, the rest is gray", () => {
	const groups = names(graphGroups("work", vault, resolve, "light"));
	assert.deepEqual(groups["Open work"], [
		"wiki/documents/Filter · started.md",
		"wiki/documents/Filter.md",
		"wiki/documents/p3-edge.md",
	]);
	assert.deepEqual(groups["Done work"], ["wiki/documents/Idea.md", "wiki/documents/Lidar.md"]);
	assert.ok(groups["No work"].includes("Notes.md"));
	assert.ok(groups["No work"].includes("wiki/documents/Design.md"), "a design has no state");
});

test("activity mode splits by the day of the update, then the modification time", () => {
	const day = (d: number) => Date.UTC(2026, 8, d, 12);
	const docs = [
		doc("a.md", { updated: "2026-09-01" }, [], day(20)),
		doc("b.md", { updated: "2026-09-10" }, [], day(10)),
		doc("c.md", { updated: "2026-09-10" }, [], day(11)),
		doc("d.md", {}, [], day(5)),
		doc("e.md", { updated: "2026-09-12" }, [], day(1)),
		doc("f.md", {}, [], day(15)),
		doc("g.md", { updated: "not a date" }, [], day(2)),
		doc("h.md", {}, [], day(3)),
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
});
