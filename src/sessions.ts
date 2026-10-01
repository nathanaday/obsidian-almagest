import { App, ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { homedir } from "os";
import { SessionRow, SessionState, groupSessions, plainLinks, resumeCommand, threadStage } from "./agents";
import { asList, expandHome, formatAgo, lastProgressLine, linkTitle } from "./helpers";
import { findTranscript, liveAgents, resumePlace } from "./launcher";
import type AtlasPlugin from "./main";

export const SESSIONS_VIEW = "atlas-sessions";

/** A session document as the pane shows it. */
export interface Session extends SessionRow {
	file: TFile;
	description: string;
	work: string[];
	threads: string[];
	harness: string;
	harness_id: string;
	cwd: string;
	transcript: string;
}

/** Every session document of the vault. */
export function readSessions(app: App): Session[] {
	const out: Session[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith("sessions/")) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || fm.type !== "session") continue;
		const work = asList(fm.work).map(linkTitle);
		out.push({
			file,
			path: file.path,
			status: String(fm.status ?? ""),
			updated: String(fm.updated ?? ""),
			ended: String(fm.ended ?? ""),
			pid: Number(fm.pid ?? 0) || 0,
			parent: String(fm.parent ?? ""),
			description: typeof fm.description === "string" && fm.description.trim() ? fm.description : file.basename,
			work,
			threads: [...asList(fm.specs), ...asList(fm.threads)],
			harness: String(fm.harness ?? "claude"),
			harness_id: String(fm.harness_id ?? ""),
			cwd: String(fm.cwd ?? ""),
			transcript: String(fm.transcript ?? ""),
		});
	}
	return out;
}

/** The open sessions and the recent ones, with the live processes checked now. */
export async function sessionGroups(app: App, staleHours: number) {
	const rows = readSessions(app);
	const live = await liveAgents(rows.map((r) => r.pid));
	return { rows, groups: groupSessions(rows, (pid) => live.has(pid), new Date(), staleHours) };
}

/** A thread a session works on: its stub, with the stub's fields. */
interface SessionThread {
	file: TFile;
	id: string;
	status: string;
	tasks: string;
	blocked: string;
}

/**
 * The thread a session works on: the one it started last that is still started, else the
 * last it started, else the thread of the last document it wrote (a spec or a task list
 * names its thread).
 */
function sessionThread(app: App, s: Session): SessionThread | null {
	const stubOf = (title: string): SessionThread | null => {
		const file = title ? app.metadataCache.getFirstLinkpathDest(title, s.file.path) : null;
		const fm = file ? app.metadataCache.getFileCache(file)?.frontmatter : undefined;
		if (!file || !fm) return null;
		if (fm.type === "spec" || fm.type === "tasks" || fm.type === "verification") return stubOf(linkTitle(fm.thread));
		if (fm.type !== "stub") return null;
		return { file, id: String(fm.id ?? ""), status: String(fm.status ?? ""), tasks: String(fm.tasks ?? ""), blocked: String(fm.blocked ?? "") };
	};
	let fallback: SessionThread | null = null;
	for (let i = s.threads.length - 1; i >= 0; i--) {
		const t = stubOf(linkTitle(s.threads[i]));
		if (!t) continue;
		fallback ??= t;
		if (t.status === "started") return t;
	}
	if (fallback) return fallback;
	for (let i = s.work.length - 1; i >= 0; i--) {
		const t = stubOf(s.work[i]);
		if (t) return t;
	}
	return null;
}

/**
 * Resumes a session in a terminal, in the account and the folder its conversation was
 * saved under. A subagent has no conversation of its own to resume.
 */
export async function resume(plugin: AtlasPlugin, s: Session): Promise<void> {
	const id = s.harness_id.trim();
	if (!id || s.parent) {
		new Notice("Atlas: this session has no conversation of its own to resume.");
		return;
	}
	let target = { harness: s.harness, id, cwd: expandHome(s.cwd, homedir()), configDir: "" };
	if (s.harness !== "codex") {
		const transcript = findTranscript(s.transcript, id);
		if (!transcript) {
			new Notice("Atlas: Claude Code has no saved conversation for this session, so it cannot resume.", 8000);
			return;
		}
		const place = resumePlace(transcript);
		target = { ...target, cwd: place.cwd || target.cwd, configDir: place.configDir };
	}
	await plugin.runInTerminal(resumeCommand(target), "the resume command");
}

const STATE_CLASS: Record<SessionState, string> = { "needs you": "waiting", working: "working", idle: "idle", ended: "ended", lost: "ended" };

/** The pane of agent sessions: the open ones, then the ones that closed in the last two hours. */
export class SessionsView extends ItemView {
	private generation = 0;

	constructor(leaf: WorkspaceLeaf, private plugin: AtlasPlugin) {
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
		void this.render();
	}

	/** Checks the processes again and redraws; a closed terminal ends its card. */
	tick(): void {
		void this.render();
	}

	async render(): Promise<void> {
		const generation = ++this.generation;
		const { rows, groups } = await sessionGroups(this.app, this.plugin.staleHours());
		if (generation !== this.generation) return;
		const root = this.contentEl;
		root.empty();
		root.addClass("atlas-sessions");
		const now = new Date();
		const subagents = new Map<string, number>();
		for (const r of rows) {
			if (r.parent && r.status === "running") {
				const key = linkTitle(r.parent);
				subagents.set(key, (subagents.get(key) ?? 0) + 1);
			}
		}
		if (groups.open.length === 0) {
			root.createDiv({ cls: "atlas-sessions-empty", text: "No agent session is open." });
		}
		for (const { row, state } of groups.open) this.card(root, row, state, now, generation, subagents.get(row.file.basename) ?? 0);
		if (groups.recent.length > 0) {
			root.createDiv({ cls: "atlas-sessions-heading", text: "Closed in the last 2 hours" });
			for (const { row, state } of groups.recent) this.card(root, row, state, now, generation, 0);
		}
		if (groups.older > 0) {
			const more = root.createDiv({ cls: "atlas-sessions-more" });
			more.setText(`${groups.older} older ${groups.older === 1 ? "session" : "sessions"} in sessions/`);
			more.onclick = () => void this.app.workspace.openLinkText("sessions/Sessions.base", "", false);
		}
	}

	private card(root: HTMLElement, s: Session, state: SessionState, now: Date, generation: number, subagents: number): void {
		const card = root.createDiv({ cls: "atlas-session" });
		card.dataset.state = STATE_CLASS[state];
		card.onclick = () => void this.app.workspace.getLeaf(false).openFile(s.file);

		const thread = sessionThread(this.app, s);
		const top = card.createDiv({ cls: "atlas-session-top" });
		top.createSpan({ cls: "atlas-session-status", text: state });
		if (thread?.id) top.createSpan({ cls: "atlas-session-id", text: thread.id });
		if (subagents > 0) top.createSpan({ cls: "atlas-session-sub", text: `+${subagents} ${subagents === 1 ? "subagent" : "subagents"}` });
		const closed = state === "ended" || state === "lost";
		top.createSpan({ cls: "atlas-session-ago", text: formatAgo(closed ? s.ended || s.updated : s.updated, now) });
		// An open session runs in its terminal already; resuming it would open it twice.
		if (closed) {
			const button = top.createEl("button", { cls: "atlas-session-resume", text: "Resume" });
			button.onclick = (e) => {
				e.stopPropagation();
				void resume(this.plugin, s);
			};
		}

		const title = plainLinks(s.description);
		card.createDiv({ cls: "atlas-session-title", text: title }).setAttr("title", title);

		if (thread) {
			const line = card.createDiv({ cls: "atlas-session-thread" });
			line.createSpan({ cls: "atlas-session-thread-name", text: thread.file.basename });
			line.createSpan({ cls: "atlas-session-stage", text: threadStage(thread) }).dataset.stage = thread.blocked ? "blocked" : thread.status;
		}
		// The last progress line is the card's hover text, so the card stays short.
		void this.app.vault.cachedRead(s.file).then((text) => {
			const last = lastProgressLine(text);
			if (generation === this.generation && last) card.setAttr("title", plainLinks(last));
		});

	}
}
