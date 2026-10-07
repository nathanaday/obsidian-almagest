import assert from "node:assert/strict";
import { test } from "node:test";
import { checkoutTitle, checkouts, day, folderName, oneLine, readingListPath, returnBlocked, skippedLine, toReturn } from "../src/checkoutstate";

const entry = (folder: string, extra: Record<string, unknown> = {}) => ({ folder, request: "rl", date: folder.slice(9, 19), documents: 3, edited: 0, returned: "", ...extra });

test("the checkouts come newest first, with missing fields filled and nameless entries dropped", () => {
	const list = checkouts([
		entry("checkout/2026-10-04 Older"),
		entry("checkout/2026-10-06 Alpha study"),
		entry("checkout/2026-10-06 Alpha study (2)"),
		{ folder: "checkout/2026-10-05 Bare" },
		{ request: "no folder" },
	]);
	assert.deepEqual(
		list.map((c) => c.folder),
		["checkout/2026-10-06 Alpha study (2)", "checkout/2026-10-06 Alpha study", "checkout/2026-10-05 Bare", "checkout/2026-10-04 Older"],
	);
	assert.deepEqual(list[2], { folder: "checkout/2026-10-05 Bare", request: "2026-10-05 Bare", date: "", documents: 0, edited: 0, returned: "" });
	assert.deepEqual(checkouts(null), []);
	assert.deepEqual(checkouts(undefined), []);
});

test("Return is on only for a checkout with an edited copy that no return took", () => {
	const [fresh] = checkouts([entry("checkout/2026-10-06 A")]);
	const [edited] = checkouts([entry("checkout/2026-10-06 A", { edited: 2 })]);
	const [returned] = checkouts([entry("checkout/2026-10-06 A", { edited: 2, returned: "2026-10-07T09:15:00" })]);
	const [returnedClean] = checkouts([entry("checkout/2026-10-06 A", { returned: "2026-10-07T09:15:00" })]);
	assert.equal(returnBlocked(fresh!), "No copy is edited.");
	assert.equal(returnBlocked(edited!), "");
	assert.equal(returnBlocked(returned!), "Returned 2026-10-07.");
	assert.equal(returnBlocked(returnedClean!), "Returned 2026-10-07.");
	assert.equal(toReturn([fresh!, edited!, returned!, returnedClean!]), 1);
	assert.equal(toReturn([]), 0);
});

test("the paths and names of a checkout", () => {
	const [c] = checkouts([entry("checkout/2026-10-06 Alpha study")]);
	assert.equal(readingListPath(c!), "checkout/2026-10-06 Alpha study/Reading list.md");
	assert.equal(folderName("checkout/2026-10-06 Alpha study"), "2026-10-06 Alpha study");
	assert.equal(day("2026-10-06T18:00:34"), "2026-10-06");
});

test("the notice of a return names the copies it left out", () => {
	assert.equal(skippedLine([]), "");
	assert.equal(skippedLine(null), "");
	assert.equal(
		skippedLine(["checkout/2026-10-06 A/Beta (checkout).md: Beta changed since the checkout"]),
		"the return left out 1 copy: checkout/2026-10-06 A/Beta (checkout).md: Beta changed since the checkout.",
	);
	assert.equal(skippedLine(["a: gone", "b: changed"]), "the return left out 2 copies: a: gone; b: changed.");
});

test("the request is one line, and the conversation's title cuts it at a word", () => {
	assert.equal(oneLine("  reinforcement\n learning\t now "), "reinforcement learning now");
	assert.equal(checkoutTitle("reinforcement learning"), "Agent · Check out reinforcement learning");
	const long = "everything we know about reinforcement learning, policy gradients, and the papers we read last spring";
	const title = checkoutTitle(long);
	assert.ok(title.endsWith("…"));
	assert.ok(title.length <= "Agent · Check out ".length + 61);
	assert.equal(title, "Agent · Check out everything we know about reinforcement learning, policy…");
});
