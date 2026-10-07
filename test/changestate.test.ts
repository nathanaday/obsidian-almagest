import assert from "node:assert/strict";
import { test } from "node:test";
import { changeCard, rejectReason, stampText, workKind } from "../src/changestate";

const base = { type: "change", id: "chg-r8m3tb", counts: "3 create, 1 modify, 0 rename, 0 remove, 2 link rewrites" };

test("a proposed change offers Approve and Cancel, with its counts", () => {
	const card = changeCard({ ...base, status: "proposed" });
	assert.equal(card.state, "proposed");
	assert.equal(card.label, "Proposed");
	assert.equal(card.id, "chg-r8m3tb");
	assert.equal(card.counts, "3 create, 1 modify, 2 link rewrites");
	assert.deepEqual(card.buttons, ["approve", "cancel"]);
});

test("a proposed change without an id offers no buttons", () => {
	const card = changeCard({ type: "change", status: "proposed" });
	assert.equal(card.state, "proposed");
	assert.deepEqual(card.buttons, []);
	assert.match(card.line, /no id/);
});

test("each later status shows a result line and no buttons", () => {
	const applying = changeCard({ ...base, status: "applying" });
	assert.equal(applying.state, "applying");
	assert.match(applying.line, /^Being applied\./);

	const applied = changeCard({ ...base, status: "applied", applied: "2026-10-06T14:03:05" });
	assert.equal(applied.label, "Applied");
	assert.equal(applied.line, "Applied 2026-10-06 14:03.");
	assert.equal(changeCard({ ...base, status: "applied" }).line, "Applied.");

	const rejected = changeCard({ ...base, status: "rejected", reason: " not now " });
	assert.equal(rejected.line, "Rejected: not now");
	assert.equal(changeCard({ ...base, status: "rejected" }).line, "Rejected.");

	assert.equal(changeCard({ ...base, status: "superseded" }).line, "A later change replaced this one.");
	assert.match(changeCard({ ...base, status: "undone" }).line, /^Undone\./);

	for (const status of ["applying", "applied", "rejected", "superseded", "undone"]) {
		const card = changeCard({ ...base, status });
		assert.equal(card.state, status);
		assert.deepEqual(card.buttons, [], status);
		assert.equal(card.counts, "3 create, 1 modify, 2 link rewrites", status);
	}
});

test("an unknown status shows itself", () => {
	const card = changeCard({ ...base, status: "paused" });
	assert.equal(card.state, "other");
	assert.equal(card.label, "Paused");
	assert.equal(card.line, "Status: paused.");
	assert.deepEqual(card.buttons, []);
	assert.equal(changeCard({ type: "change" }).line, "This change has no status.");
});

const work = { type: "change", id: "chg-qhezxf", status: "running", kind: "ingest", files: ["a.md", "b c.txt"], counts: "" };

test("a running work document shows its kind, its last step, and Cancel only", () => {
	const card = changeCard(work, null, "16:59 extracted 4 of 9 chunks");
	assert.equal(card.state, "running");
	assert.equal(card.label, "Running");
	assert.equal(card.kind, "ingest · 2 files");
	assert.equal(card.line, "16:59 extracted 4 of 9 chunks");
	assert.equal(card.counts, "");
	assert.deepEqual(card.buttons, ["cancel"]);
});

test("a running work document with no step yet says the agent starts", () => {
	const card = changeCard({ ...work, kind: "repair", files: [] }, null, "  ");
	assert.equal(card.kind, "repair");
	assert.match(card.line, /^The agent starts\./);
	assert.deepEqual(card.buttons, ["cancel"]);
	assert.deepEqual(changeCard({ ...work, id: "" }).buttons, [], "no id, no Cancel");
});

test("Cancel on a running work document shows Cancelling until the status changes", () => {
	const card = changeCard(work, "reject", "16:59 captured a.md");
	assert.equal(card.state, "busy");
	assert.equal(card.label, "Cancelling");
	assert.deepEqual(card.buttons, []);
});

test("a decided work document keeps its kind and shows its result", () => {
	const card = changeCard({ ...work, status: "rejected", reason: "cancelled in Obsidian" }, null, "16:59 captured a.md");
	assert.equal(card.line, "Rejected: cancelled in Obsidian");
	assert.equal(card.kind, "ingest · 2 files");
	assert.equal(changeCard({ ...base, status: "proposed" }).kind, "", "a change that is no work document");
});

test("workKind", () => {
	assert.equal(workKind({ kind: "ingest", files: ["a.md"] }), "ingest · 1 file");
	assert.equal(workKind({ kind: "ingest", files: "a.md" }), "ingest");
	assert.equal(workKind({ kind: " repair " }), "repair");
	assert.equal(workKind({}), "");
});

test("a note that is not a change shows a hint", () => {
	for (const fm of [undefined, null, {}, { type: "topic", status: "proposed", id: "doc-1" }]) {
		const card = changeCard(fm);
		assert.equal(card.state, "none");
		assert.deepEqual(card.buttons, []);
	}
});

test("a running command takes the place of the status", () => {
	const applying = changeCard({ ...base, status: "proposed" }, "apply");
	assert.equal(applying.state, "busy");
	assert.equal(applying.label, "Applying");
	assert.deepEqual(applying.buttons, []);
	const cancelling = changeCard({ ...base, status: "proposed" }, "reject");
	assert.equal(cancelling.label, "Cancelling");
	assert.deepEqual(cancelling.buttons, []);
	assert.equal(changeCard(undefined, "apply").state, "none", "outside a change, busy changes nothing");
});

test("rejectReason gives change reject one line, and a default", () => {
	assert.equal(rejectReason(""), "cancelled in Obsidian");
	assert.equal(rejectReason("   "), "cancelled in Obsidian");
	assert.equal(rejectReason(" wrong topic\n  try again "), "wrong topic try again");
});

test("stampText", () => {
	assert.equal(stampText("2026-10-06T14:03:05"), "2026-10-06 14:03");
	assert.equal(stampText("2026-10-06 14:03"), "2026-10-06 14:03");
	assert.equal(stampText("yesterday"), "");
	assert.equal(stampText(undefined), "");
});
