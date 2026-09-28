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
	doc("wiki/areas/Work.md", { type: "area", created: "2026-01-01", chain: [] }),
	doc("wiki/areas/Home.md", { type: "area", created: "2026-02-01" }),
	doc("wiki/areas/Sub.md", { type: "area", created: "2026-03-01", parent: "[[Work]]", chain: ["[[Work]]"] }, ["wiki/areas/Work.md"]),
	doc("wiki/repositories/app.md", { type: "repository", parent: "[[Sub]]", chain: ["[[Work]]", "[[Sub]]"] }),
	doc("wiki/concepts/Idea.md", { type: "concept", scope: "[[app]]", chain: ["[[Work]]", "[[Sub]]", "[[app]]"] }),
	doc("wiki/concepts/Loose.md", { type: "concept", scope: "", chain: [] }),
	doc("wiki/policies/Unsynced.md", { type: "policy", scope: "[[Home]]" }),
	doc("threads/Fix/Fix.md", { type: "stub", scope: ["[[app]]"], stage: "tasks" }, ["wiki/repositories/app.md"]),
	doc("threads/Fix/Fix — Spec.md", { type: "spec", thread: "[[Fix]]" }, ["threads/Fix/Fix.md", "wiki/concepts/Idea.md"]),
	doc("threads/Old/Old.md", { type: "stub", scope: ["[[Home]]"], stage: "closed" }, ["wiki/areas/Home.md"]),
	doc("threads/Old/Old — Receipt.md", { type: "receipt", thread: "[[Old]]" }, ["threads/Old/Old.md", "wiki/concepts/Idea.md", "wiki/concepts/Loose.md"]),
	doc("sessions/2026-09/s1.md", { type: "session", threads: ["[[Fix]]"] }),
	doc("changes/2026-09/c1.md", { type: "change", thread: "" }),
	doc("Notes.md", {}, ["wiki/concepts/Idea.md"]),
];

const resolve: Resolve = (link) => vault.find((d) => d.path.endsWith(`/${link}.md`) || d.path === `${link}.md`)?.path ?? null;

function names(groups: { name: string; paths: string[] }[]): Record<string, string[]> {
	return Object.fromEntries(groups.map((g) => [g.name, [...g.paths].sort()]));
}

test("area mode groups each document under its nearest area, oldest area first", () => {
	const groups = graphGroups("area", vault, resolve, "light");
	assert.deepEqual(groups.map((g) => g.name), ["Work", "Home", "Sub"]);
	assert.deepEqual(names(groups), {
		Work: ["wiki/areas/Work.md"],
		Home: ["threads/Old/Old — Receipt.md", "threads/Old/Old.md", "wiki/areas/Home.md", "wiki/policies/Unsynced.md"],
		Sub: [
			"sessions/2026-09/s1.md",
			"threads/Fix/Fix — Spec.md",
			"threads/Fix/Fix.md",
			"wiki/areas/Sub.md",
			"wiki/concepts/Idea.md",
			"wiki/repositories/app.md",
		],
	});
	assert.equal(groups[0].color, "#2a78d6");
	assert.equal(graphGroups("area", vault, resolve, "dark")[0].color, "#3987e5");
});

test("area mode folds the areas past the eighth into one muted group", () => {
	const areas = Array.from({ length: 10 }, (_, i) =>
		doc(`wiki/areas/A${i}.md`, { type: "area", created: `2026-01-${String(i + 1).padStart(2, "0")}` }),
	);
	const groups = graphGroups("area", areas, () => null, "light");
	assert.equal(groups.length, 9);
	assert.deepEqual(groups[8], { name: "Other areas", color: "#898781", paths: ["wiki/areas/A8.md", "wiki/areas/A9.md"] });
	assert.equal(new Set(groups.slice(0, 8).map((g) => g.color)).size, 8);
});

test("type mode puts the four thread documents in one group and leaves empty groups out", () => {
	const groups = names(graphGroups("type", vault, resolve, "light"));
	assert.deepEqual(Object.keys(groups), ["Areas", "Repositories", "Concepts", "Policies", "Threads", "Sessions and changes"]);
	assert.equal(groups.Threads.length, 4);
	assert.deepEqual(groups["Sessions and changes"], ["changes/2026-09/c1.md", "sessions/2026-09/s1.md"]);
});

test("threads mode: an open thread wins over a closed one; the rest is gray", () => {
	const groups = names(graphGroups("threads", vault, resolve, "light"));
	assert.deepEqual(groups["Open threads"], [
		"sessions/2026-09/s1.md",
		"threads/Fix/Fix — Spec.md",
		"threads/Fix/Fix.md",
		"wiki/concepts/Idea.md",
		"wiki/repositories/app.md",
	]);
	assert.deepEqual(groups["Closed threads"], [
		"threads/Old/Old — Receipt.md",
		"threads/Old/Old.md",
		"wiki/areas/Home.md",
		"wiki/concepts/Loose.md",
	]);
	assert.ok(groups["No threads"].includes("Notes.md"));
	assert.ok(groups["No threads"].includes("changes/2026-09/c1.md"));
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
