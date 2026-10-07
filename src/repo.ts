import { MarkdownPostProcessorContext, MarkdownRenderChild } from "obsidian";
import { DOCUMENTS, formatAgo, repoBlock } from "./helpers";
import type AlmagestPlugin from "./main";
import { markdownFilesIn } from "./vaultfiles";

interface Commit {
	commit: string;
	time: string;
	subject: string;
}

interface Facts {
	path: string;
	exists: boolean;
	branch?: string;
	head?: string;
	dirty?: string[] | null;
	ahead?: number;
	behind_remote?: number;
	upstream?: boolean;
	recent?: Commit[] | null;
	described?: string;
	behind?: number;
}

interface Brief {
	repository?: Facts;
}

/**
 * The live status panel of a repository document: what git says now, read from the
 * binary when the document opens and on Refresh. It writes nothing; the working tree's
 * state changes with every save, so it is not in the file.
 */
export class RepoPanel extends MarkdownRenderChild {
	constructor(containerEl: HTMLElement, private plugin: AlmagestPlugin, private id: string, private branch: string) {
		super(containerEl);
	}

	onload(): void {
		void this.refresh();
	}

	private async refresh(): Promise<void> {
		const el = this.containerEl;
		el.empty();
		el.addClass("almagest-repo");
		el.createDiv({ cls: "almagest-repo-loading", text: "Reading git…" });
		try {
			const b = await this.plugin.almagest<Brief>(["context", this.id]);
			this.render(b.repository);
		} catch (e) {
			el.empty();
			el.createDiv({ cls: "almagest-repo-error", text: `Almagest: ${(e as Error).message}` });
			this.refreshButton(el);
		}
	}

	private render(f: Facts | undefined): void {
		const el = this.containerEl;
		el.empty();
		if (!f || !f.exists) {
			el.createDiv({ cls: "almagest-repo-error", text: `${f?.path ?? "The path"} is gone, or is no git work tree.` });
			this.refreshButton(el);
			return;
		}
		const head = el.createDiv({ cls: "almagest-repo-head" });
		head.createSpan({ cls: "almagest-repo-branch", text: f.branch ?? "?" });
		if (this.branch && f.branch && f.branch !== this.branch) {
			head.createSpan({ cls: "almagest-repo-note", text: `not ${this.branch}` });
		}
		head.createSpan({ cls: "almagest-repo-sha", text: f.head ?? "" });
		if (f.upstream) {
			head.createSpan({ cls: "almagest-repo-sync", text: `${f.ahead ?? 0} ahead · ${f.behind_remote ?? 0} behind the remote` });
		}
		this.refreshButton(head);
		const dirty = f.dirty ?? [];
		if (dirty.length === 0) {
			el.createDiv({ cls: "almagest-repo-clean", text: "No uncommitted changes." });
		} else {
			const d = el.createEl("details", { cls: "almagest-repo-dirty" });
			d.createEl("summary", { text: `${dirty.length} ${dirty.length === 1 ? "file" : "files"} changed and not committed` });
			const ul = d.createEl("ul");
			for (const p of dirty) ul.createEl("li", { text: p });
		}
		const now = new Date();
		for (const c of f.recent ?? []) {
			const row = el.createDiv({ cls: "almagest-repo-commit" });
			row.createSpan({ cls: "almagest-repo-sha", text: c.commit });
			row.createSpan({ cls: "almagest-repo-subject", text: c.subject });
			row.createSpan({ cls: "almagest-repo-ago", text: formatAgo(c.time, now) });
		}
		if (f.described && (f.behind ?? 0) > 0) {
			el.createDiv({ cls: "almagest-repo-note", text: `The description is ${f.behind} commits behind (repo-ingest).` });
		}
	}

	private refreshButton(parent: HTMLElement): void {
		const b = parent.createEl("button", { cls: "almagest-repo-refresh", text: "Refresh" });
		b.onclick = () => void this.refresh();
	}
}

/** Renders the almagest-repo code block of a repository document. */
export function repoProcessor(plugin: AlmagestPlugin) {
	return (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		const { id } = repoBlock(source);
		if (!id) return;
		const branch = repoFields(plugin, id, ctx.sourcePath)?.branch;
		ctx.addChild(new RepoPanel(el, plugin, id, typeof branch === "string" ? branch : ""));
	};
}

/** The frontmatter of the repository document with this id: the note that holds the block, or, in a view, the document it names. */
function repoFields(plugin: AlmagestPlugin, id: string, sourcePath: string): Record<string, unknown> | undefined {
	const cache = plugin.app.metadataCache;
	const own = plugin.app.vault.getFileByPath(sourcePath);
	const fm = own ? cache.getFileCache(own)?.frontmatter : undefined;
	if (fm?.id === id) return fm;
	for (const f of markdownFilesIn(plugin.app, DOCUMENTS)) {
		const other = cache.getFileCache(f)?.frontmatter;
		if (other?.id === id) return other;
	}
	return undefined;
}
