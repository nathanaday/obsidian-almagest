import { App, Notice, TFile } from "obsidian";
import { homedir } from "os";
import { SessionRow, groupSessions, resumeCommand } from "./agents";
import { SESSIONS, expandHome } from "./helpers";
import { findTranscript, liveAgents, resumePlace } from "./launcher";
import type AlmagestPlugin from "./main";
import { markdownFilesIn } from "./vaultfiles";

/** A session document as the palette shows it. */
export interface Session extends SessionRow {
	file: TFile;
	description: string;
	harness: string;
	harness_id: string;
	cwd: string;
	transcript: string;
	/** The Duet conversation the session runs in, when the binary linked it and the note is there. */
	conversation: TFile | null;
}

/** The note that a session's `conversation` property links, which sync writes from the Duet note's `session`. */
function conversationOf(app: App, file: TFile): TFile | null {
	const link = app.metadataCache.getFileCache(file)?.frontmatterLinks?.find((l) => l.key === "conversation")?.link;
	return link ? app.metadataCache.getFirstLinkpathDest(link, file.path) : null;
}

/** Every session document of the vault. */
function readSessions(app: App): Session[] {
	const out: Session[] = [];
	for (const file of markdownFilesIn(app, SESSIONS)) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || fm.type !== "session") continue;
		out.push({
			file,
			path: file.path,
			status: String(fm.status ?? ""),
			updated: String(fm.updated ?? ""),
			ended: String(fm.ended ?? ""),
			pid: Number(fm.pid ?? 0) || 0,
			parent: String(fm.parent ?? ""),
			description: typeof fm.description === "string" && fm.description.trim() ? fm.description : file.basename,
			harness: String(fm.harness ?? "claude"),
			harness_id: String(fm.harness_id ?? ""),
			cwd: String(fm.cwd ?? ""),
			transcript: String(fm.transcript ?? ""),
			conversation: conversationOf(app, file),
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

/**
 * Resumes a session in a terminal, in the account and the folder its conversation was
 * saved under. A subagent has no conversation of its own to resume.
 */
export async function resume(plugin: AlmagestPlugin, s: Session): Promise<void> {
	const id = s.harness_id.trim();
	if (!id || s.parent) {
		new Notice("Almagest: this session has no conversation of its own to resume.");
		return;
	}
	let target = { harness: s.harness, id, cwd: expandHome(s.cwd, homedir()), configDir: "" };
	if (s.harness !== "codex") {
		const transcript = findTranscript(s.transcript, id);
		if (!transcript) {
			new Notice("Almagest: Claude Code has no saved conversation for this session, so it cannot resume.", 8000);
			return;
		}
		const place = resumePlace(transcript);
		target = { ...target, cwd: place.cwd || target.cwd, configDir: place.configDir };
	}
	await plugin.runInTerminal(resumeCommand(target), "the resume command");
}
