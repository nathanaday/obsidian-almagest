import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptAll, acceptedLine, decide, draftTitle, findMarks, isWikified, linkFor, locate, mask, parseMark, replacement, wikifyBlocked } from "../src/marks";

const fields = (text: string) => findMarks(text).map(({ kind, title, phrase }) => ({ kind, title, phrase }));

test("finds a link mark and a new mark with their offsets", () => {
	const text = "Uses {{link:Gradient Descent|gradient descent}} and {{new:Momentum|momentum}}.\n";
	const marks = findMarks(text);
	assert.equal(marks.length, 2);
	assert.deepEqual(marks[0], { from: 5, to: 47, kind: "link", title: "Gradient Descent", phrase: "gradient descent", text: "{{link:Gradient Descent|gradient descent}}" });
	assert.deepEqual(marks[1], { from: 52, to: 77, kind: "new", title: "Momentum", phrase: "momentum", text: "{{new:Momentum|momentum}}" });
	for (const m of marks) assert.equal(text.slice(m.from, m.to), m.text);
});

test("two marks on a line, and marks on several lines, come in order", () => {
	const text = "A {{link:A|a}} b {{new:B|b}}\nc {{link:C|c}}\n";
	assert.deepEqual(
		fields(text).map((m) => m.title),
		["A", "B", "C"],
	);
});

test("Unicode phrases and titles keep their offsets in UTF-16 units, as the editor counts", () => {
	const text = "Le {{new:Café Ünïcode|café ünïcode idea}} 🚀 et {{link:Straße|Straße}}.";
	const marks = findMarks(text);
	assert.deepEqual(
		marks.map((m) => [m.title, m.phrase]),
		[
			["Café Ünïcode", "café ünïcode idea"],
			["Straße", "Straße"],
		],
	);
	for (const m of marks) assert.equal(text.slice(m.from, m.to), m.text);
	assert.equal(decide(text, marks[1]!, "accept"), "Le {{new:Café Ünïcode|café ünïcode idea}} 🚀 et [[Straße]].");
});

test("a mark in a code span, a fence, a comment, or the frontmatter is text", () => {
	const text = [
		"---",
		"note: {{link:Front|front}}",
		"---",
		"Code `{{link:A|a}}` and ``{{link:B|b}}`` stay.",
		"```",
		"{{link:C|c}}",
		"```",
		"~~~~md",
		"{{new:D|d}}",
		"```",
		"{{new:E|e}}",
		"~~~~",
		"%% {{link:F|f}} %% <!-- {{link:G|g}}",
		"-->",
		"Only {{link:H|h}} counts.",
		"",
	].join("\n");
	assert.deepEqual(fields(text), [{ kind: "link", title: "H", phrase: "h" }]);
	assert.equal(mask(text).length, text.length);
	assert.equal(mask(text).split("\n").length, text.split("\n").length);
});

test("an indented fence of four spaces is no fence, and an unclosed fence runs to the end", () => {
	assert.deepEqual(fields("    ```\n{{link:A|a}}\n"), [{ kind: "link", title: "A", phrase: "a" }]);
	assert.deepEqual(fields("```\n{{link:A|a}}\n"), []);
});

test("a broken mark is text: a missing phrase, a bar in the phrase, a brace, a line break, an unknown kind", () => {
	for (const text of ["{{link:A}}", "{{link:A|b|c}}", "{{link:A|b}", "{{link:A|b\nc}}", "{{tag:A|a}}", "{{link:|a}}", "{{link:A|}}", "{{link:{A}|a}}"]) {
		assert.deepEqual(findMarks(text), [], text);
	}
});

test("a mark can sit right after another, and inside braces of other text", () => {
	assert.deepEqual(
		fields("{{link:A|a}}{{new:B|b}} {{{link:C|c}}}").map((m) => m.title),
		["A", "B", "C"],
	);
});

test("parseMark takes exactly one whole mark", () => {
	assert.deepEqual(parseMark("{{new:Momentum|momentum}}"), { kind: "new", title: "Momentum", phrase: "momentum", text: "{{new:Momentum|momentum}}" });
	assert.equal(parseMark(" {{new:Momentum|momentum}}"), null);
	assert.equal(parseMark("{{new:Momentum|momentum}} and more"), null);
});

test("Accept and Link write [[Title|phrase]], or [[Title]] when the phrase is the title as written; Ignore writes the phrase", () => {
	assert.equal(linkFor({ title: "Gradient Descent", phrase: "gradient descent" }), "[[Gradient Descent|gradient descent]]");
	assert.equal(linkFor({ title: "Gradient Descent", phrase: "Gradient Descent" }), "[[Gradient Descent]]");
	assert.equal(linkFor({ title: "Gradient Descent", phrase: "descent" }), "[[Gradient Descent|descent]]");
	assert.equal(linkFor({ title: "Straße", phrase: "STRASSE" }), "[[Straße|STRASSE]]");
	assert.equal(linkFor({ title: "Ünïcode", phrase: "üNÏCODE" }), "[[Ünïcode|üNÏCODE]]");
	const m = { title: "Momentum", phrase: "the momentum term" };
	assert.equal(replacement(m, "accept"), "[[Momentum|the momentum term]]");
	assert.equal(replacement(m, "link"), "[[Momentum|the momentum term]]");
	assert.equal(replacement(m, "ignore"), "the momentum term");
});

test("decide replaces only its mark", () => {
	const text = "A {{link:A|a}} b {{new:B|b}}.";
	const [a, b] = findMarks(text);
	assert.equal(decide(text, a!, "ignore"), "A a b {{new:B|b}}.");
	assert.equal(decide(text, b!, "link"), "A {{link:A|a}} b [[B|b]].");
});

test("locate finds a mark by its exact text, the nth of equal marks, within a range of lines", () => {
	const text = "{{link:A|a}}\n`{{link:A|a}}`\nx {{link:A|a}}\n{{link:B|b}}\n";
	assert.equal(locate(text, "{{link:A|a}}")?.from, 0);
	assert.equal(locate(text, "{{link:A|a}}", 1)?.from, 30);
	assert.equal(locate(text, "{{link:A|a}}", 2), null);
	assert.equal(locate(text, "{{link:A|a}}", 0, { start: 1, end: 3 })?.from, 30);
	assert.equal(locate(text, "{{link:B|b}}", 0, { start: 0, end: 2 }), null);
	assert.equal(locate(text, "{{link:A|changed}}"), null);
});

test("acceptAll accepts every link mark and leaves new marks and code", () => {
	const text = "{{link:A|a}} and {{new:B|b}}, `{{link:C|c}}`, {{link:Gradient Descent|descent}}.";
	assert.deepEqual(acceptAll(text), { text: "[[A|a]] and {{new:B|b}}, `{{link:C|c}}`, [[Gradient Descent|descent]].", count: 2, gone: 0 });
	assert.deepEqual(acceptAll("no marks"), { text: "no marks", count: 0, gone: 0 });
});

test("acceptAll leaves a link mark whose title names no note now", () => {
	const text = "{{link:A|a}} and {{link:Gone|g}}.";
	assert.deepEqual(acceptAll(text, (t) => t !== "Gone"), { text: "[[A|a]] and {{link:Gone|g}}.", count: 1, gone: 1 });
	assert.equal(acceptedLine(1, 1), "Atlas: accepted 1 link mark. 1 names no note now; Ignore it or fix the title.");
	assert.equal(acceptedLine(2, 0), "Atlas: accepted 2 link marks.");
	assert.equal(acceptedLine(0, 2), "Atlas: no link mark to accept. 2 name no note now; Ignore them or fix the title.");
	assert.equal(acceptedLine(0, 0), "Atlas: this note holds no link mark.");
});

test("a wikified copy is a markdown note whose name ends with · wikified, or that and a number", () => {
	assert.equal(isWikified("scratchpad/My note · wikified.md"), true);
	assert.equal(isWikified("scratchpad/My note · wikified (2).md"), true);
	assert.equal(isWikified("My note · wikified.md"), true);
	assert.equal(isWikified("scratchpad/My note.md"), false);
	assert.equal(isWikified("scratchpad/My note · wikified notes.md"), false);
	assert.equal(isWikified("scratchpad/My note · wikified.txt"), false);
	assert.equal(isWikified("scratchpad/My note wikified.md"), false);
});

test("wikify takes a markdown note of the user's", () => {
	assert.equal(wikifyBlocked("journals/cs566/Week 1.md"), "");
	assert.equal(wikifyBlocked("scratchpad/Idea.md"), "");
	assert.equal(wikifyBlocked("Loose.md"), "");
	assert.equal(wikifyBlocked("ingest/Paper.MD"), "");
	assert.equal(wikifyBlocked("ingest/paper.pdf"), "Wikify takes a markdown note.");
	assert.equal(wikifyBlocked("Atlas.md"), "Wikify takes a note of yours, not Atlas.md.");
	for (const top of ["source-core", "changes", "sessions", "wiki-view", "trash", ".obsidian"]) {
		assert.equal(wikifyBlocked(`${top}/sub/Note.md`), `Wikify takes a note of yours, not one in ${top}/.`);
	}
	assert.equal(wikifyBlocked("changes.md"), "");
});

test("draftTitle reads the topic title from a draft work document's title", () => {
	assert.equal(draftTitle("2026-10-06 Draft Momentum"), "Momentum");
	assert.equal(draftTitle("2026-10-06 Draft Momentum (2)"), "Momentum");
	assert.equal(draftTitle("2026-10-06 Draft Café Ünïcode"), "Café Ünïcode");
	assert.equal(draftTitle("2026-10-06 Ingest Momentum"), null);
	assert.equal(draftTitle("Draft Momentum"), null);
});
