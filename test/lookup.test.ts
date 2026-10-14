import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanTitle, existingTitle, findOccurrence, highlightParts, hitHolds, linkBlocked, linkableText, plainSnippet, searchArgs, titleProblem, topicTitle } from "../src/lookup";

test("quick search runs search on the wiki's documents, with the query on one line", () => {
	assert.deepEqual(searchArgs("  write\n transaction "), ["search", "write transaction", "--limit", "20", "--type", "topic", "--type", "source", "--type", "repository"]);
	// A leading dash would read as an option.
	assert.equal(searchArgs("--help")[1], "help");
});

test("a topic's title is the term made clean, with a capital first letter when the first word is lower case", () => {
	assert.equal(topicTitle("write transaction"), "Write transaction");
	assert.equal(topicTitle("gRPC streams"), "gRPC streams");
	assert.equal(topicTitle("BM25F"), "BM25F");
	assert.equal(topicTitle("Change record"), "Change record");
	assert.equal(cleanTitle(" a/b:c [[d]]#e^f|g → h\tx\u0007y "), "abc defg h x y");
	assert.equal(cleanTitle("..hidden"), "hidden");
});

test("a title the binary refuses says why", () => {
	assert.equal(titleProblem("Write transaction"), "");
	assert.equal(titleProblem(""), "Give a title of words.");
	assert.match(titleProblem("é".repeat(76)), /at most 150 bytes/);
	assert.equal(titleProblem("é".repeat(75)), "");
	assert.match(titleProblem("Tag · x"), /cannot start with "Tag ·"/);
});

test("a document holds a title by its title first, then by an alias, without regard to case or Unicode form", () => {
	const docs = [
		{ title: "Change record", aliases: ["change document"] },
		{ title: "Café", aliases: [] },
		{ title: "Change document", aliases: [] },
	];
	assert.equal(existingTitle("change DOCUMENT", docs), "Change document");
	assert.equal(existingTitle("CHANGE RECORD", docs), "Change record");
	assert.equal(existingTitle("café", docs), "Café");
	assert.equal(existingTitle("Write transaction", docs), null);
	assert.equal(existingTitle("change document", docs.slice(0, 2)), "Change record");
	assert.equal(hitHolds([{ ref: { id: "doc-1", type: "topic", title: "Write Transaction", path: "x.md" } }], "write transaction"), true);
	assert.equal(hitHolds([], "write transaction"), false);
});

test("the occurrence is the first whole-word place in the body that names the query, else its longest word", () => {
	const text = "---\ntitle: write transaction\n---\n\nA rewrite. The Write  transaction ends; a write transaction commits.\n";
	const at = findOccurrence(text, "write transaction");
	assert.ok(at);
	assert.equal(text.slice(at.from, at.to), "write transaction");
	const word = findOccurrence("Each transaction commits once.\n", "write transaction");
	assert.ok(word);
	assert.equal("Each transaction commits once.\n".slice(word.from, word.to), "transaction");
	assert.equal(findOccurrence("Nothing here.\n", "write transaction"), null);
	assert.equal(findOccurrence("Rewrites.\n", "write"), null);
	assert.deepEqual(findOccurrence("Uses a+b (sum).\n", "a+b"), { from: 5, to: 8 });
});

test("a snippet shows each link's text, and the query's words stand out", () => {
	assert.equal(plainSnippet("See [[Write transaction]] and [[Change record|the record]],\n done."), "See Write transaction and the record, done.");
	assert.deepEqual(highlightParts("The write transaction rewrites.", "Write"), [
		{ text: "The ", hit: false },
		{ text: "write", hit: true },
		{ text: " transaction rewrites.", hit: false },
	]);
	assert.deepEqual(highlightParts("Text", ""), [{ text: "Text", hit: false }]);
});

test("a selection becomes a link only in one line with no link, and never in code's notes or records", () => {
	assert.equal(linkableText("write transaction"), true);
	assert.equal(linkableText("two\nlines"), false);
	assert.equal(linkableText("see [[Alpha]]"), false);
	assert.equal(linkableText("  "), false);
	assert.equal(linkBlocked("tool/source-core/documents/Alpha.md", ".obsidian"), "");
	assert.equal(linkBlocked("journals/cs566/week 3.md", ".obsidian"), "");
	assert.equal(linkBlocked("scratchpad/Idea.md", ".obsidian"), "");
	for (const path of ["changes/2026-10-12 Draft X.md", "tool/sessions/2026-10/s.md", "wiki-view/nav/Tag · x.md", "tool/trash/2026-10-12/a.md", "Tool/Source-Core/originals/a.md", ".obsidian/x.md"]) {
		assert.match(linkBlocked(path, ".obsidian"), /writes no link into/, path);
	}
	assert.match(linkBlocked("diagram.canvas", ".obsidian"), /markdown note/);
});
