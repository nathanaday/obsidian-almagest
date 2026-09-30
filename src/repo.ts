import { MarkdownPostProcessorContext, MarkdownRenderChild } from "obsidian";
import { formatAgo, repoBlock } from "./helpers";
import type AtlasPlugin from "./main";

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
	constructor(containerEl: HTMLElement, private plugin: AtlasPlugin, private id: string, private branch: string) {
		super(containerEl);
	}

	onload(): void {
		void this.refresh();
	}

	private async refresh(): Promise<void> {
		const el = this.containerEl;
		el.empty();
		el.addClass("atlas-repo");
		el.createDiv({ cls: "atlas-repo-loading", text: "Reading git…" });
		try {
			const b = await this.plugin.atlas<Brief>(["context", this.id]);
			this.render(b.repository);
		} catch (e) {
			el.empty();
			el.createDiv({ cls: "atlas-repo-error", text: `Atlas: ${(e as Error).message}` });
			this.refreshButton(el);
		}
	}

	private render(f: Facts | undefined): void {
		const el = this.containerEl;
		el.empty();
		if (!f || !f.exists) {
			el.createDiv({ cls: "atlas-repo-error", text: `${f?.path ?? "The path"} is gone, or is no git work tree.` });
			this.refreshButton(el);
			return;
		}
		const head = el.createDiv({ cls: "atlas-repo-head" });
		head.createSpan({ cls: "atlas-repo-branch", text: f.branch ?? "?" });
		if (this.branch && f.branch && f.branch !== this.branch) {
			head.createSpan({ cls: "atlas-repo-note", text: `not ${this.branch}` });
		}
		head.createSpan({ cls: "atlas-repo-sha", text: f.head ?? "" });
		if (f.upstream) {
			head.createSpan({ cls: "atlas-repo-sync", text: `${f.ahead ?? 0} ahead · ${f.behind_remote ?? 0} behind the remote` });
		}
		this.refreshButton(head);
		const dirty = f.dirty ?? [];
		if (dirty.length === 0) {
			el.createDiv({ cls: "atlas-repo-clean", text: "No uncommitted changes." });
		} else {
			const d = el.createEl("details", { cls: "atlas-repo-dirty" });
			d.createEl("summary", { text: `${dirty.length} ${dirty.length === 1 ? "file" : "files"} changed and not committed` });
			const ul = d.createEl("ul");
			for (const p of dirty) ul.createEl("li", { text: p });
		}
		const now = new Date();
		for (const c of f.recent ?? []) {
			const row = el.createDiv({ cls: "atlas-repo-commit" });
			row.createSpan({ cls: "atlas-repo-sha", text: c.commit });
			row.createSpan({ cls: "atlas-repo-subject", text: c.subject });
			row.createSpan({ cls: "atlas-repo-ago", text: formatAgo(c.time, now) });
		}
		if (f.described && (f.behind ?? 0) > 0) {
			el.createDiv({ cls: "atlas-repo-note", text: `The description is ${f.behind} commits behind (repo-ingest).` });
		}
	}

	private refreshButton(parent: HTMLElement): void {
		const b = parent.createEl("button", { cls: "atlas-repo-refresh", text: "Refresh" });
		b.onclick = () => void this.refresh();
	}
}

/** Renders the atlas-repo code block of a repository document. */
export function repoProcessor(plugin: AtlasPlugin) {
	return (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		const { id } = repoBlock(source);
		if (!id) return;
		ctx.addChild(new RepoPanel(el, plugin, id, String(repoFields(plugin, id, ctx.sourcePath)?.branch ?? "")));
	};
}

/** The frontmatter of the repository document with this id: the note that holds the block, or, in a view, the document it names. */
function repoFields(plugin: AtlasPlugin, id: string, sourcePath: string): Record<string, unknown> | undefined {
	const cache = plugin.app.metadataCache;
	const own = plugin.app.vault.getFileByPath(sourcePath);
	const fm = own ? cache.getFileCache(own)?.frontmatter : undefined;
	if (fm?.id === id) return fm;
	for (const f of plugin.app.vault.getMarkdownFiles()) {
		if (!f.path.startsWith("wiki/documents/")) continue;
		const other = cache.getFileCache(f)?.frontmatter;
		if (other?.id === id) return other;
	}
	return undefined;
}
