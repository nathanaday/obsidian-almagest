import { App, ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { homedir } from "os";
import { runProgram } from "./cli";
import {
	asList,
	compareSessions,
	formatAgo,
	lastProgressLine,
	linkTitle,
	resumeCommand,
	terminalArgs,
} from "./helpers";

export const SESSIONS_VIEW = "atlas-sessions";

export interface ActiveSession {
	file: TFile;
	status: string;
	description: string;
	work: string;
	specs: string[];
	updated: string;
	harness: string;
	harness_id: string;
	cwd: string;
}

/** The sessions with status running or waiting: waiting first, then the newest. */
export function activeSessions(app: App): ActiveSession[] {
	const out: ActiveSession[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith("sessions/")) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || fm.type !== "session") continue;
		if (fm.status !== "running" && fm.status !== "waiting") continue;
		const work = asList(fm.work);
		out.push({
			file,
			status: fm.status,
			description: typeof fm.description === "string" && fm.description.trim() ? fm.description : file.basename,
			work: linkTitle(work[work.length - 1]),
			specs: asList(fm.specs),
			updated: String(fm.updated ?? ""),
			harness: String(fm.harness ?? "claude"),
			harness_id: String(fm.harness_id ?? ""),
			cwd: String(fm.cwd ?? ""),
		});
	}
	return out.sort(compareSessions);
}

/** The plan the session started last that is still started, else the last it started. */
function currentPlan(app: App, s: ActiveSession): { title: string; file: TFile | null } | null {
	let fallback: { title: string; file: TFile | null } | null = null;
	for (let i = s.specs.length - 1; i >= 0; i--) {
		const title = linkTitle(s.specs[i]);
		if (!title) continue;
		const file = app.metadataCache.getFirstLinkpathDest(title, s.file.path);
		const entry = { title, file };
		fallback ??= entry;
		if (file && app.metadataCache.getFileCache(file)?.frontmatter?.status === "started") return entry;
	}
	return fallback;
}

export async function resume(s: ActiveSession): Promise<void> {
	const command = resumeCommand(s, homedir());
	if (!command) {
		new Notice("Atlas: this session has no harness id to resume.");
		return;
	}
	if (process.platform !== "darwin") {
		await navigator.clipboard.writeText(command);
		new Notice("Atlas: copied the resume command. Run it in a terminal.");
		return;
	}
	try {
		await runProgram("osascript", terminalArgs(command));
	} catch (e) {
		new Notice(`Atlas: cannot open Terminal: ${(e as Error).message}`);
	}
}

/** The pane that lists the running and waiting sessions. */
export class SessionsView extends ItemView {
	private generation = 0;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return SESSIONS_VIEW;
	}

	getDisplayText(): string {
		return "Atlas sessions";
	}

	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	/** Rewrites the "ago" times only. */
	tick(): void {
		const now = new Date();
		this.contentEl.querySelectorAll<HTMLElement>(".atlas-session-ago").forEach((el) => {
			el.setText(formatAgo(el.dataset.updated, now));
		});
	}

	render(): void {
		const generation = ++this.generation;
		const root = this.contentEl;
		root.empty();
		root.addClass("atlas-sessions");
		const sessions = activeSessions(this.app);
		if (sessions.length === 0) {
			root.createDiv({ cls: "atlas-sessions-empty", text: "No session is running or waiting." });
			return;
		}
		const now = new Date();
		for (const s of sessions) {
			const card = root.createDiv({ cls: "atlas-session" });
			card.dataset.status = s.status;
			card.onclick = () => void this.app.workspace.getLeaf(false).openFile(s.file);

			const head = card.createDiv({ cls: "atlas-session-head" });
			head.createSpan({ cls: "atlas-session-status", text: s.status });
			head.createSpan({ cls: "atlas-session-title", text: s.description });

			const task = currentPlan(this.app, s);
			const where = (task?.title ?? s.work) || "";
			if (where) card.createDiv({ cls: "atlas-session-where", text: where });

			const progress = card.createDiv({ cls: "atlas-session-progress" });
			if (task?.file) {
				void this.app.vault.cachedRead(task.file).then((text) => {
					if (generation === this.generation) progress.setText(lastProgressLine(text));
				});
			}

			const foot = card.createDiv({ cls: "atlas-session-foot" });
			const ago = foot.createSpan({ cls: "atlas-session-ago", text: formatAgo(s.updated, now) });
			ago.dataset.updated = s.updated;
			const button = foot.createEl("button", { text: "Resume" });
			button.onclick = (e) => {
				e.stopPropagation();
				void resume(s);
			};
		}
	}
}
