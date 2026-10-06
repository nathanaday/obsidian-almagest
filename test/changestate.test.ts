import assert from "node:assert/strict";
import { test } from "node:test";
import { changeCard, rejectReason, stampText } from "../src/changestate";

const base = { type: "change", id: "chg-r8m3tb", counts: "3 create, 1 modify, 0 rename, 0 remove, 2 link rewrites" };

test("a proposed change offers Approve and Cancel, with its counts", () => {
	const card = changeCard({ ...base, status: "proposed" });
	assert.equal(card.state, "proposed");
	assert.equal(card.label, "Proposed");
	assert.equal(card.id, "chg-r8m3tb");
	assert.equal(card.counts, "3 create, 1 modify, 2 link rewrites");
	assert.ok(card.actions);
});

test("a proposed change without an id offers no buttons", () => {
	const card = changeCard({ type: "change", status: "proposed" });
	assert.equal(card.state, "proposed");
	assert.ok(!card.actions);
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
		assert.ok(!card.actions, status);
		assert.equal(card.counts, "3 create, 1 modify, 2 link rewrites", status);
	}
});

test("an unknown status shows itself", () => {
	const card = changeCard({ ...base, status: "running" });
	assert.equal(card.state, "other");
	assert.equal(card.label, "Running");
	assert.equal(card.line, "Status: running.");
	assert.ok(!card.actions);
	assert.equal(changeCard({ type: "change" }).line, "This change has no status.");
});

test("a note that is not a change shows a hint", () => {
	for (const fm of [undefined, null, {}, { type: "topic", status: "proposed", id: "doc-1" }]) {
		const card = changeCard(fm);
		assert.equal(card.state, "none");
		assert.ok(!card.actions);
	}
});

test("a running command takes the place of the status", () => {
	const applying = changeCard({ ...base, status: "proposed" }, "apply");
	assert.equal(applying.state, "busy");
	assert.equal(applying.label, "Applying");
	assert.ok(!applying.actions);
	const cancelling = changeCard({ ...base, status: "proposed" }, "reject");
	assert.equal(cancelling.label, "Cancelling");
	assert.ok(!cancelling.actions);
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
