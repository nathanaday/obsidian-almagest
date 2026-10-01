// Pure functions for agent sessions and terminals: no Obsidian, no Node. The tests cover them.

/** A session document's fields, as the sessions pane reads them. */
export interface SessionRow {
	path: string;
	status: string;
	updated: string;
	ended: string;
	pid: number;
	/** The session this one is a subagent of, or "". */
	parent: string;
}

/** Where a session stands for the pane. */
export type SessionState = "working" | "needs you" | "idle" | "ended" | "lost";

const LIVE = ["running", "waiting", "idle"];

/** How long an ended session stays in the pane's recent group. */
export const RECENT_MS = 2 * 60 * 60 * 1000;

/**
 * Whether a session is open. With a process id, the process decides; without one (a
 * session a hook recorded before 8.0.2), the status decides while the last event is
 * younger than staleHours.
 */
export function isOpen(row: SessionRow, alive: (pid: number) => boolean, now: Date, staleHours: number): boolean {
	if (!LIVE.includes(row.status)) return false;
	if (row.pid > 0) return alive(row.pid);
	const t = Date.parse(row.updated);
	return !Number.isNaN(t) && now.getTime() - t < staleHours * 3600 * 1000;
}

/** The pane's word for an open session's status, or for a closed one. */
export function sessionState(row: SessionRow, open: boolean): SessionState {
	if (!open) return row.status === "lost" ? "lost" : "ended";
	if (row.status === "waiting") return "needs you";
	if (row.status === "running") return "working";
	return "idle";
}

const STATE_RANK: Record<SessionState, number> = { "needs you": 0, working: 1, idle: 2, ended: 3, lost: 3 };

export interface SessionGroups<T extends SessionRow> {
	open: { row: T; state: SessionState }[];
	recent: { row: T; state: SessionState }[];
	older: number;
}

/**
 * The pane's groups: the open sessions (needs you, then working, then idle, the newest
 * first in each), the sessions that closed in the last two hours, and a count of the
 * older ones. A subagent's session is no card of its own.
 */
export function groupSessions<T extends SessionRow>(rows: T[], alive: (pid: number) => boolean, now: Date, staleHours: number): SessionGroups<T> {
	const out: SessionGroups<T> = { open: [], recent: [], older: 0 };
	for (const row of rows) {
		if (row.parent) continue;
		const open = isOpen(row, alive, now, staleHours);
		const state = sessionState(row, open);
		if (open) {
			out.open.push({ row, state });
			continue;
		}
		const t = Date.parse(row.ended || row.updated);
		if (!Number.isNaN(t) && now.getTime() - t < RECENT_MS) out.recent.push({ row, state });
		else out.older++;
	}
	const newest = (a: T, b: T) => String(b.updated).localeCompare(String(a.updated));
	out.open.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || newest(a.row, b.row));
	out.recent.sort((a, b) => String(b.row.ended || b.row.updated).localeCompare(String(a.row.ended || a.row.updated)));
	return out;
}

/** A string as one POSIX shell word. */
export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A string as an AppleScript string literal. */
export function appleScriptString(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The config folder of a Claude Code transcript: the part before /projects/. */
export function configDirOf(transcript: string): string {
	const i = transcript.lastIndexOf("/projects/");
	return i > 0 ? transcript.slice(0, i) : "";
}

/** The folder a conversation started in: the first cwd its transcript records. */
export function firstCwd(jsonl: string): string {
	for (const line of jsonl.split("\n")) {
		if (!line.includes('"cwd"')) continue;
		try {
			const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
			if (typeof cwd === "string" && cwd) return cwd;
		} catch {
			// A line cut at the read's end.
		}
	}
	return "";
}

export interface ResumeTarget {
	harness: string;
	id: string;
	/** The folder to resume in. */
	cwd: string;
	/** Claude Code's config folder that holds the conversation, or "". */
	configDir: string;
}

/** The shell command that resumes a session in its folder and its account. */
export function resumeCommand(t: ResumeTarget): string {
	const parts: string[] = [];
	if (t.cwd) parts.push(`cd ${shellQuote(t.cwd)}`);
	if (t.harness === "codex") {
		parts.push(`codex resume ${shellQuote(t.id)}`);
	} else {
		if (t.configDir) parts.push(`export CLAUDE_CONFIG_DIR=${shellQuote(t.configDir)}`);
		parts.push(`claude --resume ${shellQuote(t.id)}`);
	}
	return parts.join(" && ");
}

/**
 * The shell command that starts an agent in a folder with a first prompt. agent is the
 * user's command, as they would type it: "claude", or a shell function of their own.
 */
export function startCommand(dir: string, agent: string, prompt: string): string {
	const program = agent.trim() || "claude";
	return `cd ${shellQuote(dir)} && ${program} ${shellQuote(prompt)}`;
}

/** The terminals Atlas opens a command in. */
export const TERMINALS = ["terminal", "iterm", "wezterm", "ghostty", "custom"] as const;
export type TerminalApp = (typeof TERMINALS)[number];

export const TERMINAL_NAMES: Record<TerminalApp, string> = {
	terminal: "Terminal",
	iterm: "iTerm2",
	wezterm: "WezTerm",
	ghostty: "Ghostty",
	custom: "Custom command",
};

/** One program to run, with its arguments. */
export interface Launch {
	program: string;
	args: string[];
}

/**
 * How to open a terminal that runs a command in the user's interactive shell, so their
 * PATH and shell functions apply, and stays open after it. custom is a template with
 * {command} for the quoted command.
 */
export function terminalLaunch(app: TerminalApp, command: string, shell: string, custom: string): Launch {
	const sh = shell || "/bin/zsh";
	const interactive = [sh, "-lic", `${command}; exec ${sh} -l`];
	switch (app) {
		case "iterm":
			return {
				program: "osascript",
				args: [
					"-e", 'tell application "iTerm" to create window with default profile',
					"-e", `tell application "iTerm" to tell current session of current window to write text ${appleScriptString(command)}`,
					"-e", 'tell application "iTerm" to activate',
				],
			};
		case "wezterm":
			return { program: "/Applications/WezTerm.app/Contents/MacOS/wezterm", args: ["start", "--", ...interactive] };
		case "ghostty":
			return { program: "open", args: ["-na", "Ghostty", "--args", "-e", ...interactive] };
		case "custom":
			return { program: "/bin/sh", args: ["-c", custom.split("{command}").join(shellQuote(command))] };
		default:
			return {
				program: "osascript",
				args: [
					"-e", `tell application "Terminal" to do script ${appleScriptString(command)}`,
					"-e", 'tell application "Terminal" to activate',
				],
			};
	}
}
