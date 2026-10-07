import assert from "node:assert/strict";
import { test } from "node:test";
import { ingestMessage, publishMessage, repairMessage, resolveMessage } from "../src/messages";

const doc = { id: "chg-qhezxf", title: "2026-10-06 Ingest 2 files" };

test("Ingest names the work document, its id, and how to report and propose", () => {
	assert.equal(
		ingestMessage(doc),
		"/atlas-obsidian:wiki-ingest Ingest the files of ingest/ into the wiki. Your work document is [[2026-10-06 Ingest 2 files]] (chg-qhezxf): report each step with change progress, and propose into it with change propose and id chg-qhezxf.",
	);
});

test("Repair with an agent runs wiki-review into its work document", () => {
	assert.equal(
		repairMessage({ id: "chg-r8m3tb", title: "2026-10-06 Repair the lint findings" }),
		"/atlas-obsidian:wiki-review Repair the lint findings that a change repairs. Your work document is [[2026-10-06 Repair the lint findings]] (chg-r8m3tb): report each step with change progress, and propose the repairs into it with change propose and id chg-r8m3tb.",
	);
});

test("Publish runs wiki-sync on the edition, into its work document", () => {
	const edition = { id: "doc-e48had", title: "User Journal CS566 Notes - 6 October 2026 Edition" };
	const work = { id: "chg-tw95fx", title: "2026-10-06 Ingest User Journal CS566 Notes - 6 October 2026 Edition" };
	assert.equal(
		publishMessage(edition, work),
		"/atlas-obsidian:wiki-sync Absorb the source [[User Journal CS566 Notes - 6 October 2026 Edition]] (doc-e48had), the user's journal edition. Cite it where its ideas land. Your work document is [[2026-10-06 Ingest User Journal CS566 Notes - 6 October 2026 Edition]] (chg-tw95fx): report each step with change progress, and propose into it with change propose and id chg-tw95fx.",
	);
});

test("Resolve with an agent names the file, its path, and the documents that link it", () => {
	const target = { title: "Beta", path: "source-core/documents/Beta.md" };
	assert.equal(
		resolveMessage(target, [{ title: "Alpha" }]),
		"/atlas-obsidian:wiki-edit Remove [[Beta]] (source-core/documents/Beta.md), which [[Alpha]] links: point each backlink elsewhere, or drop it, then propose a remove.",
	);
	assert.equal(
		resolveMessage(target, [{ title: "Alpha" }, { title: "2026-10-06 Add A" }]),
		"/atlas-obsidian:wiki-edit Remove [[Beta]] (source-core/documents/Beta.md), which [[Alpha]], [[2026-10-06 Add A]] link: point each backlink elsewhere, or drop it, then propose a remove.",
	);
	const many = Array.from({ length: 13 }, (_, i) => ({ title: `T${i}` }));
	const text = resolveMessage(target, many);
	assert.match(text, /\[\[T9\]\], 3 more link:/);
	assert.ok(!text.includes("[[T10]]"));
});

test("every message runs a skill of the atlas-obsidian plugin and stays on one line", () => {
	for (const m of [ingestMessage(doc), repairMessage(doc), publishMessage({ id: "doc-1", title: "E" }, doc), resolveMessage({ title: "x", path: "x.md" }, [{ title: "y" }])]) {
		assert.match(m, /^\/atlas-obsidian:wiki-(ingest|review|sync|edit) /);
		assert.ok(!m.includes("\n"));
	}
});
