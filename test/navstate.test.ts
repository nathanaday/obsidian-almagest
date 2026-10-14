import assert from "node:assert/strict";
import { test } from "node:test";
import { navGroups, navLine, navMeta, Neighbors } from "../src/navstate";

const doc = (title: string, extra: Record<string, unknown> = {}) => ({ id: `doc-${title}`, type: "topic", title, path: `tool/source-core/documents/${title}.md`, ...extra });

// The shape `neighbors --json` prints, trimmed.
const attention: Neighbors = {
	document: doc("Attention"),
	up: [doc("Machine Learning")],
	beside: [],
	below: null,
	sources_below: [],
	sources: [doc("Block 5 Slides", { type: "source" }), doc("Block 6 Slides", { type: "source" }), doc("Block 7 Slides", { type: "source" })],
	cited_by: [],
};

test("the navigator shows the groups that hold a document, in order", () => {
	assert.deepEqual(
		navGroups(attention).map((g) => [g.label, g.refs.map((r) => r.title)]),
		[
			["Up", ["Machine Learning"]],
			["Sources", ["Block 5 Slides", "Block 6 Slides", "Block 7 Slides"]],
		],
	);
	assert.deepEqual(navGroups({ document: doc("Alone") }), []);
});

test("the navigator's home line names the document and counts what lies around it", () => {
	assert.equal(navLine(attention, true), "Attention · 1 up, 3 sources");
	assert.equal(navLine({ document: doc("Alone"), up: [] }, true), "Alone · nothing around it");
	assert.equal(navLine(null, true), "Reading the document…");
	assert.equal(navLine(null, false), "Open a wiki document");
});

test("a neighbor's line is its kind or type, and its description", () => {
	assert.equal(navMeta(doc("A", { kind: "concept", description: "What A is." })), "concept · What A is.");
	assert.equal(navMeta(doc("B", { type: "source" })), "source");
});
