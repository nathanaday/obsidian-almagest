import assert from "node:assert/strict";
import { test } from "node:test";
import { editionTitle, journalName, journalVolumes, numbered, publishBlocked, toPublish, volumeOf } from "../src/journalstate";

test("a volume's name reads as journal.Name gives it (internal/journal TestNames)", () => {
	const cases: Record<string, string> = { "cs566-notes": "CS566 Notes", deep_work: "Deep Work", Garden: "Garden", "p3 field log": "P3 Field Log" };
	for (const [folder, want] of Object.entries(cases)) assert.equal(journalName(folder), want, folder);
});

test("an edition's title names the volume and the day, as journal.Title gives it", () => {
	assert.equal(editionTitle("cs566-notes", new Date(2026, 9, 6, 9, 0, 0)), "User Journal CS566 Notes - 6 October 2026 Edition");
	assert.equal(editionTitle("garden", new Date(2027, 0, 31, 23, 59)), "User Journal Garden - 31 January 2027 Edition");
});

test("a name keeps repeated separators to one space, and capitals only the first letter", () => {
	assert.equal(journalName("--deep__work  log-"), "Deep Work Log");
	assert.equal(journalName("iPhone notes"), "IPhone Notes");
	assert.equal(journalName("école"), "École");
	assert.equal(journalName("x2"), "X2");
	assert.equal(journalName("2026 log"), "2026 Log");
});

test("the volumes come from the status in the binary's order, with missing fields filled", () => {
	const vols = journalVolumes([
		{ volume: "cs566-notes", name: "CS566 Notes", notes: 2, edition: "", changed: true },
		{ volume: "garden", notes: 0 },
		{ name: "no folder" },
	]);
	assert.deepEqual(vols, [
		{ volume: "cs566-notes", name: "CS566 Notes", notes: 2, edition: "", changed: true },
		{ volume: "garden", name: "Garden", notes: 0, edition: "", changed: false },
	]);
	assert.equal(toPublish(vols), 1);
	assert.deepEqual(journalVolumes(null), []);
});

test("Publish is off for a volume with no note or no change", () => {
	const vol = { volume: "garden", name: "Garden", notes: 3, edition: "", changed: true };
	assert.equal(publishBlocked(vol), "");
	assert.equal(publishBlocked({ ...vol, notes: 0, changed: false }), "The volume holds no note.");
	assert.equal(publishBlocked({ ...vol, changed: false, edition: "User Journal Garden - 5 October 2026 Edition" }), "No change since User Journal Garden - 5 October 2026 Edition.");
});

test("a path lies in a volume when it is inside journals/<volume>/", () => {
	assert.equal(volumeOf("journals/cs566-notes/Week 1.md"), "cs566-notes");
	assert.equal(volumeOf("journals/cs566-notes/labs/Lab 1.md"), "cs566-notes");
	assert.equal(volumeOf("journals/cs566-notes/Journal · cs566-notes.md"), "cs566-notes");
	assert.equal(volumeOf("journals/Loose.md"), "");
	assert.equal(volumeOf("journals/.hidden/a.md"), "");
	assert.equal(volumeOf("scratchpad/journals/a/b.md"), "");
	assert.equal(volumeOf(""), "");
});

test("a second edition of one day takes a number", () => {
	const title = "User Journal Garden - 6 October 2026 Edition";
	assert.equal(numbered("", title), false);
	assert.equal(numbered("User Journal Garden - 5 October 2026 Edition", title), false);
	assert.equal(numbered(title, title), true);
	assert.equal(numbered(`${title} (2)`, title), true);
});
