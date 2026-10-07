import assert from "node:assert/strict";
import { test } from "node:test";
import { checkoutMessage, draftMessage, ingestMessage, publishMessage, repairMessage, resolveMessage, wikifyMessage } from "../src/messages";

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

test("Checkout runs wiki-checkout on the user's request, on one line", () => {
	assert.equal(checkoutMessage("reinforcement learning"), "/atlas-obsidian:wiki-checkout Check out the material on: reinforcement learning");
	assert.equal(checkoutMessage("  policy\n gradients "), "/atlas-obsidian:wiki-checkout Check out the material on: policy gradients");
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

test("Resolve with an agent leaves the user's files, and then proposes no remove", () => {
	const target = { title: "Beta", path: "source-core/documents/Beta.md" };
	assert.equal(
		resolveMessage(target, [{ title: "Alpha" }], [{ title: "Week 1" }]),
		"/atlas-obsidian:wiki-edit Remove [[Beta]] (source-core/documents/Beta.md), which [[Alpha]] links: point each backlink elsewhere, or drop it. [[Week 1]] is the user's to fix, so leave it and propose no remove; the user runs Safe delete again.",
	);
	assert.match(resolveMessage(target, [{ title: "Alpha" }], [{ title: "A" }, { title: "B" }]), /\[\[A\]\], \[\[B\]\] are the user's to fix, so leave them and propose no remove;/);
});

test("Create on a new mark runs wiki-edit to draft the topic from the wikified note, into its work document", () => {
	assert.equal(
		draftMessage("Momentum", "My note · wikified", { id: "chg-qrjq13", title: "2026-10-06 Draft Momentum" }),
		"/atlas-obsidian:wiki-edit Draft a topic titled Momentum from [[My note · wikified]] and what the wiki holds; give it a why. Your work document is [[2026-10-06 Draft Momentum]] (chg-qrjq13): report each step with change progress, and propose into it with change propose and id chg-qrjq13.",
	);
});

test("Wikify this note runs wiki-wikify on the copy", () => {
	assert.equal(
		wikifyMessage("My note · wikified (2)"),
		"/atlas-obsidian:wiki-wikify Wikify [[My note · wikified (2)]]: mark what the wiki knows and the subjects worth a topic, with wikify mark.",
	);
});

test("every message runs a skill of the atlas-obsidian plugin and stays on one line", () => {
	for (const m of [ingestMessage(doc), repairMessage(doc), publishMessage({ id: "doc-1", title: "E" }, doc), resolveMessage({ title: "x", path: "x.md" }, [{ title: "y" }]), checkoutMessage("a\nb"), draftMessage("T", "N", doc), wikifyMessage("N")]) {
		assert.match(m, /^\/atlas-obsidian:wiki-(ingest|review|sync|edit|checkout|wikify) /);
		assert.ok(!m.includes("\n"));
	}
});
