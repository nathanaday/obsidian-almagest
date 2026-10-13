// Quick search and Make topic, on a term selected in a note: from the editor's menu and
// from two commands. Quick search lists the wiki's hits in a box; Make topic links the
// selection to the topic to be and starts the agent that drafts it.

import { App, ButtonComponent, Editor, EditorPosition, Keymap, MarkdownFileInfo, MarkdownView, Modal, Notice, Platform, Setting, SuggestModal, TFile, parseFrontMatterAliases } from "obsidian";
import { DOCUMENTS, isDocumentType } from "./helpers";
import { SearchHit, SearchResult, cleanTitle, existingTitle, findOccurrence, highlightParts, hitHolds, linkBlocked, linkableText, plainSnippet, searchArgs, searchQuery, titleProblem, topicTitle } from "./lookup";
import type AlmagestPlugin from "./main";
import { linkFor } from "./marks";
import { markdownFilesIn } from "./vaultfiles";

/** A term the user chose in a note: its text, and where it stood. */
interface Selection {
	editor: Editor;
	info: MarkdownView | MarkdownFileInfo;
	file: TFile;
	from: EditorPosition;
	to: EditorPosition;
	text: string;
}

/** The selection, trimmed of the spaces around it; with none, the word at the cursor when word is set. */
function selectionOf(editor: Editor, info: MarkdownView | MarkdownFileInfo, word: boolean): Selection | null {
	const file = info.file;
	if (!file) return null;
	let from = editor.getCursor("from");
	let to = editor.getCursor("to");
	if (from.line === to.line && from.ch === to.ch) {
		const range = word ? editor.wordAt(from) : null;
		if (!range) return null;
		({ from, to } = range);
	}
	const raw = editor.getRange(from, to);
	const text = raw.trim();
	if (!text) return null;
	if (from.line === to.line) {
		from = { line: from.line, ch: from.ch + (raw.length - raw.trimStart().length) };
		to = { line: to.line, ch: to.ch - (raw.length - raw.trimEnd().length) };
	}
	return { editor, info, file, from, to, text };
}

/** Why the selection cannot become a link, or "". */
function unlinkable(app: App, sel: Selection): string {
	if (!linkableText(sel.text)) return "Almagest links a selection of one line that holds no link.";
	return linkBlocked(sel.file.path, app.vault.configDir);
}

/** Replaces the selection with a link to title, when the note still shows it as it was. */
function linkSelection(sel: Selection, title: string): boolean {
	if (sel.info.file?.path !== sel.file.path || sel.editor.getRange(sel.from, sel.to) !== sel.text) {
		new Notice("Almagest: the selection changed since you chose it. Nothing was linked.");
		return false;
	}
	sel.editor.replaceRange(linkFor({ title, phrase: sel.text }), sel.from, sel.to);
	return true;
}

/** The wiki's documents with their aliases, as Obsidian reads them. */
function documents(app: App): { title: string; aliases: string[] }[] {
	return markdownFilesIn(app, DOCUMENTS).flatMap((file) => {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!isDocumentType(fm?.type)) return [];
		return [{ title: file.basename, aliases: parseFrontMatterAliases(fm) ?? [] }];
	});
}

/** Opens Obsidian's own search with the query, which finds the text in every file. */
function searchAllFiles(app: App, query: string): void {
	type GlobalSearch = { openGlobalSearch?(query: string): void };
	const plugins = (app as unknown as { internalPlugins?: { getEnabledPluginById?(id: string): GlobalSearch | null } }).internalPlugins;
	const search = plugins?.getEnabledPluginById?.("global-search");
	if (!search?.openGlobalSearch) {
		new Notice("Almagest: Obsidian's search plugin is off. Turn it on under core plugins in the settings.");
		return;
	}
	const q = searchQuery(query).replace(/"/g, "");
	search.openGlobalSearch(q.includes(" ") ? `"${q}"` : q);
}

/** Make topic: the title is the user's to confirm; a document that holds it gets the link instead of a draft. */
async function makeTopic(plugin: AlmagestPlugin, title: string, sel: Selection): Promise<void> {
	const existing = existingTitle(title, documents(plugin.app));
	if (existing) {
		if (linkSelection(sel, existing)) new Notice(`Almagest: ${existing} exists, so the selection links it. No agent started.`);
		return;
	}
	const draft = plugin.wikify.draftOf(title);
	if (draft !== null) {
		if (linkSelection(sel, title)) new Notice(`Almagest: an agent drafts ${title} already, so the selection links it. No agent started.`);
		return;
	}
	linkSelection(sel, title);
	await plugin.wikify.create(title, sel.file.path, sel.text);
}

type Row = { kind: "hit"; hit: SearchHit } | { kind: "make"; title: string } | { kind: "files" };

const mod = Platform.isMacOS ? "⌘" : "Ctrl";
const alt = Platform.isMacOS ? "⌥" : "Alt";

/** The search box: the wiki's hits for the query as the user types, then Make topic and Obsidian's search. */
class QuickSearchModal extends SuggestModal<Row> {
	private seq = 0;
	private rows: Row[] = [];
	private lastError = "";

	constructor(
		private plugin: AlmagestPlugin,
		private query: string,
		private sel: Selection | null,
	) {
		super(plugin.app);
		this.limit = 30;
		this.emptyStateText = "Type a term to search the wiki.";
		this.setPlaceholder("Search the wiki");
		const keys = [
			{ command: "↑↓", purpose: "to navigate" },
			{ command: "↵", purpose: "to open" },
			{ command: `${mod} ↵`, purpose: "to open in a new tab" },
		];
		if (sel && !unlinkable(plugin.app, sel)) keys.push({ command: `${alt} ↵`, purpose: "to link the selection" });
		keys.push({ command: "esc", purpose: "to dismiss" });
		this.setInstructions(keys);
		this.scope.register(["Mod"], "Enter", (evt) => {
			this.selectActiveSuggestion(evt);
			return false;
		});
		this.scope.register(["Alt"], "Enter", (evt) => {
			this.selectActiveSuggestion(evt);
			return false;
		});
		this.modalEl.addClass("almagest-search");
	}

	onOpen(): void {
		void super.onOpen();
		this.inputEl.value = this.query;
		this.inputEl.dispatchEvent(new Event("input"));
		this.inputEl.select();
	}

	async getSuggestions(input: string): Promise<Row[]> {
		const query = searchQuery(input);
		const n = ++this.seq;
		if (!query) return (this.rows = []);
		let hits: SearchHit[] = [];
		try {
			hits = (await this.plugin.almagest<SearchResult>(searchArgs(query))).hits ?? [];
			this.lastError = "";
		} catch (e) {
			const message = (e as Error).message;
			if (message !== this.lastError) new Notice(`Almagest: ${message}`, 8000);
			this.lastError = message;
		}
		// A later keystroke's search answers instead.
		if (n !== this.seq) return this.rows;
		const rows: Row[] = hits.map((hit) => ({ kind: "hit", hit }));
		const title = topicTitle(query);
		if (this.sel && !unlinkable(this.app, this.sel) && !titleProblem(title) && !hitHolds(hits, title)) rows.push({ kind: "make", title });
		rows.push({ kind: "files" });
		return (this.rows = rows);
	}

	renderSuggestion(row: Row, el: HTMLElement): void {
		const query = this.inputEl.value;
		el.addClass("almagest-search-row");
		el.dataset.kind = row.kind;
		if (row.kind === "hit") {
			const { ref, snippet } = row.hit;
			const head = el.createDiv({ cls: "almagest-search-head" });
			const title = head.createSpan({ cls: "almagest-search-title" });
			for (const part of highlightParts(ref.title, query)) {
				if (part.hit) title.createEl("mark", { text: part.text });
				else title.appendText(part.text);
			}
			head.createSpan({ cls: "almagest-chip", text: ref.kind || ref.type, attr: { "data-tone": "muted" } });
			if (ref.description) el.createDiv({ cls: "almagest-search-description", text: ref.description });
			const text = plainSnippet(snippet ?? "");
			if (text) {
				const line = el.createDiv({ cls: "almagest-search-snippet" });
				for (const part of highlightParts(text, query)) {
					if (part.hit) line.createEl("mark", { text: part.text });
					else line.appendText(part.text);
				}
			}
		} else if (row.kind === "make") {
			el.createDiv({ cls: "almagest-search-title", text: `Make topic “${row.title}”` });
			el.createDiv({ cls: "almagest-search-description", text: "An agent drafts it from this note and the wiki, and the selection links it." });
		} else {
			el.createDiv({ cls: "almagest-search-title", text: `Search all files for “${searchQuery(query)}”` });
			el.createDiv({ cls: "almagest-search-description", text: "Obsidian's search, which reads every note: journals and the scratchpad too." });
		}
	}

	onChooseSuggestion(row: Row, evt: MouseEvent | KeyboardEvent): void {
		const query = this.inputEl.value;
		if (row.kind === "files") return searchAllFiles(this.app, query);
		if (row.kind === "make") {
			if (this.sel) new MakeTopicModal(this.plugin, row.title, this.sel).open();
			return;
		}
		if (evt.altKey && this.sel) {
			const problem = unlinkable(this.app, this.sel);
			if (problem) new Notice(`Almagest: ${problem}`);
			else linkSelection(this.sel, row.hit.ref.title);
			return;
		}
		void this.openHit(row.hit, query, Keymap.isModEvent(evt) !== false);
	}

	/** Opens the hit's document at the first place that names the query, as Obsidian's search does. */
	private async openHit(hit: SearchHit, query: string, newTab: boolean): Promise<void> {
		const file = this.app.vault.getFileByPath(hit.ref.path);
		if (!file) {
			new Notice(`Almagest: Obsidian does not see ${hit.ref.path}.`);
			return;
		}
		const content = await this.app.vault.cachedRead(file);
		const at = findOccurrence(content, query);
		const leaf = this.app.workspace.getLeaf(newTab ? "tab" : false);
		await leaf.openFile(file, { active: true, eState: at ? { match: { content, matches: [[at.from, at.to]] } } : undefined });
	}
}

/** Asks for the topic's title, from the selection; Make topic links the selection and starts the agent. */
class MakeTopicModal extends Modal {
	constructor(
		private plugin: AlmagestPlugin,
		private title: string,
		private sel: Selection,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.setTitle("Make topic");
		const el = this.contentEl;
		el.addClass("almagest-make-topic");
		el.createEl("p", { text: "An agent drafts the topic from this note and what the wiki holds, and proposes it as a change for you to approve. The selection links the topic now." });
		let go: ButtonComponent | undefined;
		const problem = el.createEl("p", { cls: "almagest-make-topic-problem" });
		const check = () => {
			const why = titleProblem(cleanTitle(this.title));
			problem.setText(why);
			go?.setDisabled(why !== "");
			return why === "";
		};
		const submit = () => {
			if (!check()) return;
			this.close();
			void makeTopic(this.plugin, cleanTitle(this.title), this.sel);
		};
		new Setting(el)
			.setName("Title")
			.setDesc("The topic's title, as links name it.")
			.addText((text) => {
				text.setValue(this.title).onChange((v) => {
					this.title = v;
					check();
				});
				text.inputEl.addClass("almagest-make-topic-input");
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter" && !e.isComposing) {
						e.preventDefault();
						submit();
					}
				});
				window.setTimeout(() => text.inputEl.select(), 0);
			});
		new Setting(el)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				go = b.setButtonText("Make topic").setCta().onClick(submit);
			});
		check();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Quick search and Make topic in the editor's menu while text is selected, and as commands. */
export function registerLookup(plugin: AlmagestPlugin): void {
	const { app } = plugin;
	const quickSearch = (sel: Selection | null, query: string) => new QuickSearchModal(plugin, query, sel).open();
	const make = (sel: Selection) => {
		const problem = unlinkable(app, sel);
		if (problem) {
			new Notice(`Almagest: ${problem}`);
			return;
		}
		new MakeTopicModal(plugin, topicTitle(sel.text), sel).open();
	};

	plugin.registerEvent(
		app.workspace.on("editor-menu", (menu, editor, info) => {
			if (!plugin.ready()) return;
			const sel = selectionOf(editor, info, false);
			if (!sel) return;
			menu.addItem((item) =>
				item
					.setTitle("Almagest quick search")
					.setIcon("search")
					.setSection("selection")
					.onClick(() => quickSearch(sel, sel.text)),
			);
			if (!unlinkable(app, sel)) {
				menu.addItem((item) =>
					item
						.setTitle("Almagest make topic")
						.setIcon("file-plus")
						.setSection("selection")
						.onClick(() => make(sel)),
				);
			}
		}),
	);

	plugin.addCommand({
		id: "quick-search",
		name: "Quick search the wiki",
		checkCallback: (checking) => {
			if (!plugin.ready()) return false;
			if (!checking) {
				const view = app.workspace.getActiveViewOfType(MarkdownView);
				const sel = view && view.getMode() === "source" ? selectionOf(view.editor, view, true) : null;
				quickSearch(sel, sel?.text ?? "");
			}
			return true;
		},
	});
	plugin.addCommand({
		id: "make-topic",
		name: "Make topic from the selection",
		editorCheckCallback: (checking, editor, info) => {
			if (!plugin.ready()) return false;
			const sel = selectionOf(editor, info, true);
			if (!sel || unlinkable(app, sel)) return false;
			if (!checking) make(sel);
			return true;
		},
	});
}
