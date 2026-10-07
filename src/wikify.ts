import { RangeSetBuilder, StateEffect, Text } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownView, Notice, TFile, debounce, editorInfoField, editorLivePreviewField } from "obsidian";
import { saveOpen } from "./change";
import type AtlasPlugin from "./main";
import { Decision, Mark, acceptAll, decide as decideMark, draftTitle, findMarks, isWikified, linkFor, locate, replacement, wikifyBlocked } from "./marks";
import { draftMessage, wikifyMessage } from "./messages";
import { noteTitle } from "./palettestate";

/** A mark as a bubble shows it: no offsets, since the text moves. */
type MarkFields = Pick<Mark, "kind" | "title" | "phrase" | "text">;

/**
 * What a bubble offers. A link: Accept. A new subject: Create; drafting while its draft
 * work document runs or waits for the user; Link once a note has its title.
 */
type BubbleState = { kind: "link" } | { kind: "new" } | { kind: "drafting"; path: string } | { kind: "ready" };

const DRAFTING = ["running", "proposed", "applying"];
const CHANGED = "Atlas: this mark changed since it showed. Nothing was replaced.";
const REFRESH_MS = 300;

/** The state behind every bubble: what each mark offers, and Create. */
export class Wikify {
	private listeners = new Set<() => void>();
	/** The titles whose Create runs now. */
	private creating = new Set<string>();
	/** The draft work documents this session started, by topic title, until the cache reads them. */
	private started = new Map<string, string>();
	/** The draft work documents that run or wait for the user, by topic title; built when a bubble asks. */
	private drafts: Map<string, string> | null = null;
	private readonly soon = debounce(() => this.refresh(), REFRESH_MS, true);

	constructor(private plugin: AtlasPlugin) {}

	/** Draws the bubbles again when a note that a title could resolve to, or a draft, changes. */
	register(): void {
		const { plugin } = this;
		const { vault, metadataCache } = plugin.app;
		plugin.registerEvent(metadataCache.on("changed", () => this.soon()));
		plugin.registerEvent(vault.on("create", () => this.soon()));
		plugin.registerEvent(vault.on("delete", () => this.soon()));
		plugin.registerEvent(vault.on("rename", () => this.soon()));
		plugin.register(() => this.soon.cancel());
	}

	/** Calls fn when a bubble may offer something else; returns the call that stops it. */
	listen(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	refresh(): void {
		this.drafts = null;
		for (const fn of this.listeners) fn();
	}

	state(mark: MarkFields, sourcePath: string): BubbleState {
		if (mark.kind === "link") return { kind: "link" };
		if (this.plugin.app.metadataCache.getFirstLinkpathDest(mark.title, sourcePath)) return { kind: "ready" };
		const path = this.draftOf(mark.title);
		if (path !== null) return { kind: "drafting", path };
		return { kind: "new" };
	}

	/** The draft work document of a title that runs or waits, "" while Create starts it, or null. */
	private draftOf(title: string): string | null {
		if (this.creating.has(title)) return "";
		const { metadataCache, vault } = this.plugin.app;
		if (!this.drafts) {
			this.drafts = new Map();
			for (const file of vault.getMarkdownFiles()) {
				if (!file.path.startsWith("changes/")) continue;
				const fm = metadataCache.getFileCache(file)?.frontmatter;
				const t = draftTitle(file.basename);
				if (t && fm?.kind === "draft" && DRAFTING.includes(fm.status)) this.drafts.set(t, file.path);
			}
		}
		const found = this.drafts.get(title);
		if (found) return found;
		// A document the binary just wrote: the cache has not read it yet.
		const path = this.started.get(title);
		if (path) {
			const file = vault.getFileByPath(path);
			if (!file || !metadataCache.getFileCache(file)?.frontmatter) return path;
			this.started.delete(title);
		}
		return null;
	}

	/** Create: a draft work document, then the agent that drafts the topic into it. */
	async create(title: string, sourcePath: string): Promise<void> {
		if (this.creating.has(title)) return;
		this.creating.add(title);
		this.refresh();
		try {
			// The agent reads the note as the user sees it.
			await saveOpen(this.plugin.app, sourcePath);
			const { ref } = await this.plugin.atlas<{ ref: { id: string; title: string; path: string } }>(["change", "start", "--kind", "draft", "--title", `Draft ${title}`]);
			this.started.set(title, ref.path);
			await this.plugin.runAgent(draftMessage(title, noteTitle(sourcePath), ref), `Agent · ${ref.title}`, "draft");
		} catch (e) {
			new Notice(`Atlas: ${(e as Error).message}`, 10_000);
		} finally {
			this.creating.delete(title);
			this.refresh();
		}
	}

	openDraft(path: string): void {
		if (path) void this.plugin.openWhenSeen(path, true);
	}

	/** Accept on every link mark of a wikified note: through the editor when it shows the note, else on disk. */
	async acceptAll(file: TFile): Promise<void> {
		const { workspace, vault } = this.plugin.app;
		let count = 0;
		const view = workspace.getActiveViewOfType(MarkdownView);
		if (view?.file?.path === file.path && view.getMode() === "source") {
			const editor = view.editor;
			const marks = findMarks(editor.getValue()).filter((m) => m.kind === "link");
			count = marks.length;
			if (count > 0) editor.transaction({ changes: marks.map((m) => ({ from: editor.offsetToPos(m.from), to: editor.offsetToPos(m.to), text: linkFor(m) })) });
		} else {
			await vault.process(file, (text) => {
				const out = acceptAll(text);
				count = out.count;
				return out.text;
			});
		}
		new Notice(count > 0 ? `Atlas: accepted ${count === 1 ? "1 link mark" : `${count} link marks`}.` : "Atlas: this note holds no link mark.");
	}

	/**
	 * Wikify this note: the binary copies the note into the scratchpad, the copy opens, and
	 * an agent marks it.
	 */
	async wikify(file: TFile): Promise<void> {
		const why = wikifyBlocked(file.path);
		if (why) throw new Error(why);
		// An edit typed a moment ago goes into the copy.
		await saveOpen(this.plugin.app, file.path);
		// A path that begins with a dash would read as an option.
		const arg = file.path.startsWith("-") ? `./${file.path}` : file.path;
		const { copy } = await this.plugin.atlas<{ copy: string }>(["wikify", "start", arg]);
		await this.plugin.openWhenSeen(copy, true);
		const title = noteTitle(copy);
		await this.plugin.runAgent(wikifyMessage(title), `Agent · ${title}`, "wikify");
	}
}

/** Draws a bubble: the phrase, the pill, and the buttons that the state offers. */
function drawBubble(el: HTMLElement, w: Wikify, mark: MarkFields, state: BubbleState, decide: (d: Decision) => void, sourcePath: string): void {
	el.empty();
	el.className = `atlas-mark atlas-mark-${mark.kind}`;
	el.dataset.state = state.kind;
	el.dataset.title = mark.title;
	el.createSpan({ cls: "atlas-mark-phrase", text: mark.phrase });
	el.createSpan({ cls: "atlas-mark-pill", text: `${mark.kind === "link" ? "→" : "+"} ${mark.title}` });
	const button = (text: string, run: () => void, cta = false) => {
		const b = el.createEl("button", { cls: cta ? "atlas-mark-button mod-cta" : "atlas-mark-button", text });
		b.dataset.action = text.toLowerCase();
		// The editor keeps its selection: a press on a button is no click in the text.
		b.addEventListener("mousedown", (e) => e.preventDefault());
		b.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			run();
		});
	};
	switch (state.kind) {
		case "link":
			button("Accept", () => decide("accept"), true);
			break;
		case "new":
			button("Create", () => void w.create(mark.title, sourcePath), true);
			break;
		case "drafting": {
			const label = el.createSpan({ cls: "atlas-mark-drafting", text: "drafting" });
			if (state.path) {
				label.setAttr("title", state.path);
				label.addEventListener("mousedown", (e) => e.preventDefault());
				label.addEventListener("click", (e) => {
					e.stopPropagation();
					w.openDraft(state.path);
				});
			}
			break;
		}
		case "ready":
			button("Link", () => decide("link"), true);
			break;
	}
	button("Ignore", () => decide("ignore"));
}

const sameState = (a: BubbleState, b: BubbleState) => a.kind === b.kind && (a.kind !== "drafting" || a.path === (b as { path: string }).path);

// Live preview

const refreshMarks = StateEffect.define<null>();

class MarkWidget extends WidgetType {
	constructor(
		readonly mark: MarkFields,
		readonly state: BubbleState,
		private w: Wikify,
		private sourcePath: string,
	) {
		super();
	}

	eq(other: MarkWidget): boolean {
		return other.mark.text === this.mark.text && sameState(other.state, this.state) && other.sourcePath === this.sourcePath;
	}

	toDOM(view: EditorView): HTMLElement {
		const el = document.createElement("span");
		drawBubble(el, this.w, this.mark, this.state, (d) => this.decide(view, el, d), this.sourcePath);
		return el;
	}

	/** Replaces the mark the bubble stands for, found again where the bubble is now. */
	private decide(view: EditorView, el: HTMLElement, decision: Decision): void {
		const pos = view.posAtDOM(el);
		const m = findMarks(view.state.doc.toString()).find((x) => x.from <= pos && pos <= x.to && x.text === this.mark.text);
		if (!m) {
			new Notice(CHANGED);
			return;
		}
		view.dispatch({ changes: { from: m.from, to: m.to, insert: replacement(m, decision) }, userEvent: "input" });
	}

	/** A click on a button is the bubble's; a click on the phrase puts the cursor in the mark, which shows its text. */
	ignoreEvent(event: Event): boolean {
		const target = event.target as HTMLElement | null;
		return !!target?.closest?.(".atlas-mark-button, .atlas-mark-drafting");
	}
}

/**
 * Replaces each mark of a wikified note with a bubble in live preview, except where the
 * selection touches it: there the text shows, to edit. No other note changes.
 */
export function markExtension(w: Wikify) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			private doc: Text | null = null;
			private marks: Mark[] = [];
			private stop: () => void;
			private gone = false;

			constructor(private view: EditorView) {
				this.decorations = this.build();
				this.stop = w.listen(() => {
					if (!this.path()) return;
					// A listener may run inside another editor's update.
					window.setTimeout(() => {
						if (!this.gone) this.view.dispatch({ effects: refreshMarks.of(null) });
					}, 0);
				});
			}

			update(u: ViewUpdate): void {
				const toggled = u.startState.field(editorLivePreviewField, false) !== u.state.field(editorLivePreviewField, false);
				const refreshed = u.transactions.some((t) => t.effects.some((e) => e.is(refreshMarks)));
				if (u.docChanged || u.selectionSet || toggled || refreshed) this.decorations = this.build();
			}

			destroy(): void {
				this.gone = true;
				this.stop();
			}

			/** The wikified note this editor shows in live preview, or "". */
			private path(): string {
				const state = this.view.state;
				const path = state.field(editorInfoField, false)?.file?.path ?? "";
				return isWikified(path) && state.field(editorLivePreviewField, false) ? path : "";
			}

			private build(): DecorationSet {
				const path = this.path();
				if (!path) return Decoration.none;
				const state = this.view.state;
				if (state.doc !== this.doc) {
					this.doc = state.doc;
					this.marks = findMarks(state.doc.toString());
				}
				const builder = new RangeSetBuilder<Decoration>();
				const ranges = state.selection.ranges;
				for (const m of this.marks) {
					if (ranges.some((r) => r.from <= m.to && r.to >= m.from)) continue;
					builder.add(m.from, m.to, Decoration.replace({ widget: new MarkWidget(m, w.state(m, path), w, path) }));
				}
				return builder.finish();
			}
		},
		{ decorations: (v) => v.decorations },
	);
}

// Reading view

/** A bubble in rendered text: nth counts the equal marks before it in its section. */
interface Bubble {
	el: HTMLElement;
	mark: MarkFields;
	nth: number;
	state?: BubbleState;
}

/** The bubbles of one rendered section. They draw again when what they offer may change. */
class MarkBubbles extends MarkdownRenderChild {
	constructor(
		containerEl: HTMLElement,
		private w: Wikify,
		private plugin: AtlasPlugin,
		private ctx: MarkdownPostProcessorContext,
		private bubbles: Bubble[],
	) {
		super(containerEl);
	}

	onload(): void {
		this.register(this.w.listen(() => this.draw()));
		this.draw();
	}

	private draw(): void {
		for (const b of this.bubbles) {
			const state = this.w.state(b.mark, this.ctx.sourcePath);
			if (b.state && sameState(b.state, state)) continue;
			b.state = state;
			drawBubble(b.el, this.w, b.mark, state, (d) => void this.decide(b, d), this.ctx.sourcePath);
		}
	}

	/** Replaces the mark in the file, found again by its exact text in the section. */
	private async decide(b: { mark: MarkFields; nth: number }, decision: Decision): Promise<void> {
		const file = this.plugin.app.vault.getFileByPath(this.ctx.sourcePath);
		const info = this.ctx.getSectionInfo(this.containerEl);
		const lines = info ? { start: info.lineStart, end: info.lineEnd } : undefined;
		let done = false;
		if (file) {
			await this.plugin.app.vault.process(file, (text) => {
				const m = locate(text, b.mark.text, lines ? b.nth : 0, lines);
				if (!m) return text;
				done = true;
				return decideMark(text, m, decision);
			});
		}
		if (!done) new Notice(CHANGED);
	}
}

/** Replaces each mark in the rendered text of a wikified note with a bubble. Code stays text. */
export function markPostProcessor(plugin: AtlasPlugin, w: Wikify) {
	return (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		if (!isWikified(ctx.sourcePath)) return;
		const nodes: globalThis.Text[] = [];
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
			acceptNode: (n) =>
				n.parentElement?.closest("code, pre, .atlas-mark") ? NodeFilter.FILTER_REJECT : n.nodeValue?.includes("{{") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
		});
		for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as globalThis.Text);
		const bubbles: Bubble[] = [];
		const seen = new Map<string, number>();
		for (const node of nodes) {
			const text = node.nodeValue ?? "";
			const marks = findMarks(text);
			if (marks.length === 0) continue;
			const frag = document.createDocumentFragment();
			let at = 0;
			for (const m of marks) {
				if (m.from > at) frag.append(text.slice(at, m.from));
				const span = document.createElement("span");
				frag.append(span);
				const nth = seen.get(m.text) ?? 0;
				seen.set(m.text, nth + 1);
				bubbles.push({ el: span, mark: { kind: m.kind, title: m.title, phrase: m.phrase, text: m.text }, nth });
				at = m.to;
			}
			if (at < text.length) frag.append(text.slice(at));
			node.replaceWith(frag);
		}
		if (bubbles.length > 0) ctx.addChild(new MarkBubbles(el, w, plugin, ctx, bubbles));
	};
}
