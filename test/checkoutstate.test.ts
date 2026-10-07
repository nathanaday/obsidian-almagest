import assert from "node:assert/strict";
import { test } from "node:test";
import { checkoutTitle, checkouts, day, folderName, indexPath, oneLine, outOnly, returnedLine, skippedLine, toReturn } from "../src/checkoutstate";

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
	assert.deepEqual(list[2], { folder: "checkout/2026-10-05 Bare", name: "Bare", request: "2026-10-05 Bare", date: "", documents: 0, edited: 0, status: "out", returned: "" });
	assert.deepEqual(checkouts(null), []);
	assert.deepEqual(checkouts(undefined), []);
});

test("the checkouts out, and those whose edits wait for a return", () => {
	const [fresh] = checkouts([entry("checkout/2026-10-06 A")]);
	const [edited] = checkouts([entry("checkout/2026-10-06 A", { edited: 2 })]);
	const [returned] = checkouts([entry("tool/returned/2026-10-06 A", { edited: 2, status: "returned", returned: "2026-10-07T09:15:00" })]);
	assert.deepEqual(outOnly([fresh!, edited!, returned!]), [fresh, edited]);
	assert.equal(toReturn([fresh!, edited!, returned!]), 1);
	assert.equal(toReturn([]), 0);
});

test("the notice of a return says where the checkout went, and what its change proposes", () => {
	const change = { ref: { id: "chg-a", title: "2026-10-07 Return Alpha study", path: "changes/x.md" }, counts: { modify: 2 } };
	assert.equal(
		returnedLine("Alpha study", { change, folder: "tool/returned/2026-10-06 Alpha study" }),
		"Returned Alpha study to tool/returned/2026-10-06 Alpha study. 2026-10-07 Return Alpha study proposes your edits to 2 documents; approve it in the change.",
	);
	assert.equal(
		returnedLine("Alpha study", { folder: "tool/returned/2026-10-06 Alpha study" }),
		"Returned Alpha study to tool/returned/2026-10-06 Alpha study. No copy was edited, so nothing changes in the wiki.",
	);
});

test("the paths and names of a checkout", () => {
	const [c] = checkouts([entry("checkout/2026-10-06 Alpha study")]);
	assert.equal(indexPath(c!), "checkout/2026-10-06 Alpha study/_index.md");
	assert.equal(c!.name, "Alpha study");
	assert.equal(folderName("checkout/2026-10-06 Alpha study"), "2026-10-06 Alpha study");
	assert.equal(day("2026-10-06T18:00:34"), "2026-10-06");
});

test("the notice of a return names the copies it left out", () => {
	assert.equal(skippedLine([]), "");
	assert.equal(skippedLine(null), "");
	assert.equal(
		skippedLine(["checkout/2026-10-06 A/Beta (checkout).md: Beta changed since the checkout"]),
		"the return left out 1 copy, whose edits stay in the returned copies: checkout/2026-10-06 A/Beta (checkout).md: Beta changed since the checkout.",
	);
	assert.equal(skippedLine(["a: gone", "b: changed"]), "the return left out 2 copies, whose edits stay in the returned copies: a: gone; b: changed.");
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
