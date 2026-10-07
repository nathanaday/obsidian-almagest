// The Duet tip at the top of Almagest.md, in live preview and in reading view. The plugin
// draws it while Duet is the choice and does not run; it never writes it into the file,
// which every agent reads as the vault's context and git shares between machines.

import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { MarkdownPostProcessorContext, editorInfoField, editorLivePreviewField, setIcon } from "obsidian";
import { DUET_LINK, DUET_TIP } from "./agents";
import { VAULT_DOCUMENT, firstBodyLine } from "./helpers";

/** What the tip reads: whether to show it, and a way to hear when that may change. */
export interface TipSource {
	show(): boolean;
	listen(fn: () => void): () => void;
}

/** The tip as a tip callout, as Obsidian draws one. */
export function tipElement(): HTMLElement {
	const callout = createDiv({ cls: "callout almagest-duet-tip", attr: { "data-callout": "tip" } });
	const title = callout.createDiv({ cls: "callout-title" });
	setIcon(title.createDiv({ cls: "callout-icon" }), "lightbulb");
	title.createDiv({ cls: "callout-title-inner", text: "Tip" });
	const content = callout.createDiv({ cls: "callout-content" });
	content.createEl("p", { text: DUET_TIP });
	const install = content.createEl("p");
	install.createEl("strong", { text: "Install Duet: " });
	const link = install.createEl("a", { text: "Duet in Obsidian's community plugins", href: DUET_LINK, cls: "almagest-duet-link" });
	link.onclick = (evt) => {
		evt.preventDefault();
		window.open(DUET_LINK);
	};
	content.createEl("p", { cls: "almagest-duet-tip-note", text: "To start agents in a terminal without this tip, open the Almagest settings and choose the terminal for agent conversations." });
	return callout;
}

const refreshTip = StateEffect.define<null>();

class TipWidget extends WidgetType {
	eq(): boolean {
		return true;
	}

	// The editor lays a block out by its box, margins aside, so padding keeps the tip off the text.
	toDOM(): HTMLElement {
		const block = createDiv({ cls: "almagest-duet-tip-block" });
		block.appendChild(tipElement());
		return block;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

function tipDecorations(state: EditorState, source: TipSource): DecorationSet {
	if (state.field(editorInfoField, false)?.file?.path !== VAULT_DOCUMENT || !state.field(editorLivePreviewField, false) || !source.show()) return Decoration.none;
	const line = firstBodyLine(state.doc.toString());
	const at = line < 0 ? state.doc.length : state.doc.line(line + 1).from;
	return Decoration.set([Decoration.widget({ widget: new TipWidget(), block: true, side: -1 }).range(at)]);
}

/** The tip in live preview: a block above the first text after the properties. */
export function tipExtension(source: TipSource) {
	const field = StateField.define<DecorationSet>({
		create: (state) => tipDecorations(state, source),
		update(decorations, tr) {
			const toggled = tr.startState.field(editorLivePreviewField, false) !== tr.state.field(editorLivePreviewField, false);
			const refreshed = tr.effects.some((e) => e.is(refreshTip));
			return tr.docChanged || toggled || refreshed ? tipDecorations(tr.state, source) : decorations;
		},
		provide: (f) => EditorView.decorations.from(f),
	});
	// Block decorations come from a field alone; this plugin only tells the field to read the choice again.
	const listener = ViewPlugin.define((view) => {
		let gone = false;
		const stop = source.listen(() => {
			// A listener may run inside another editor's update.
			window.setTimeout(() => {
				if (!gone) view.dispatch({ effects: refreshTip.of(null) });
			}, 0);
		});
		return {
			destroy() {
				gone = true;
				stop();
			},
		};
	});
	return [field, listener];
}

/**
 * The tip in reading view: at the end of the properties' section, which is above the text,
 * or before the first text in a note with no properties. The properties' section is the
 * one place: Obsidian keeps a section whose text did not change, tip and all, so a tip in
 * another section would show twice after an edit.
 */
export function tipPostProcessor(source: TipSource) {
	return (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
		if (ctx.sourcePath !== VAULT_DOCUMENT || !source.show()) return;
		const info = ctx.getSectionInfo(el);
		if (!info) return;
		if (info.text.startsWith("---\n")) {
			if (info.lineStart === 0) el.append(tipElement());
		} else if (info.lineStart === firstBodyLine(info.text)) {
			el.prepend(tipElement());
		}
	};
}
