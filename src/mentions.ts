import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import type { MarkdownPostProcessor } from "obsidian";
import { mentionRanges, textMentions } from "./helpers";

const mark = Decoration.mark({ class: "atlas-mention" });

function build(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	for (const { from, to } of view.visibleRanges) {
		let pos = from;
		while (pos <= to) {
			const line = view.state.doc.lineAt(pos);
			for (const [a, b] of mentionRanges(line.text)) builder.add(line.from + a, line.from + b, mark);
			pos = line.to + 1;
		}
	}
	return builder.finish();
}

/** Marks "@atlas" in task lines of the editor. */
export const mentionEditor = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = build(view);
		}
		update(u: ViewUpdate) {
			if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
		}
	},
	{ decorations: (v) => v.decorations },
);

/** Wraps "@atlas" in the task items of reading view. */
export const mentionReading: MarkdownPostProcessor = (el) => {
	el.querySelectorAll("li.task-list-item").forEach((item) => {
		const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			const text = n as Text;
			// A nested list's items are handled on their own.
			if (text.parentElement?.closest("li.task-list-item") !== item) continue;
			if (text.parentElement?.closest(".atlas-mention, code, a")) continue;
			if (textMentions(text.data).length > 0) nodes.push(text);
		}
		nodes.forEach(wrap);
	});
};

function wrap(node: Text): void {
	const ranges = textMentions(node.data);
	const frag = document.createDocumentFragment();
	let at = 0;
	for (const [a, b] of ranges) {
		if (a > at) frag.append(node.data.slice(at, a));
		frag.append(createSpan({ cls: "atlas-mention", text: node.data.slice(a, b) }));
		at = b;
	}
	if (at < node.data.length) frag.append(node.data.slice(at));
	node.replaceWith(frag);
}
