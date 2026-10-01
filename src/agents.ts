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

/** The agents Atlas starts. */
export const AGENTS = ["claude", "codex"] as const;
export type Agent = (typeof AGENTS)[number];

export const AGENT_NAMES: Record<Agent, string> = { claude: "Claude Code", codex: "Codex" };

/** The preferences one config file sets; a key it leaves out is not set. */
export interface Preferences {
	agent?: Agent;
	agent_commands?: Partial<Record<Agent, string>>;
	terminal?: TerminalApp;
	terminal_command?: string;
}

/** What atlas-obsidian config prints: the preferences in effect, and each file's own. */
export interface AgentConfig {
	preferences: {
		agent: Agent;
		agent_command: string;
		agent_commands: Record<Agent, string>;
		terminal: TerminalApp;
		terminal_command: string;
		sources: Record<string, "default" | "global" | "vault">;
	};
	global: Preferences;
	vault: Preferences | null;
	files: { global: string; vault?: string };
}

/** One key of a config file, as config set names it: agent, agent_commands.claude, terminal, terminal_command. */
export function preference(p: Preferences | null, key: string): string {
	if (!p) return "";
	if (key.startsWith("agent_commands.")) return p.agent_commands?.[key.slice("agent_commands.".length) as Agent] ?? "";
	return String((p as Record<string, unknown>)[key] ?? "");
}

/** What a vault gets for a key it does not set: the global file's value, else the default. */
export function inherited(config: AgentConfig, key: string): string {
	const g = preference(config.global, key);
	if (g) return g;
	if (key === "agent") return "claude";
	if (key === "terminal") return "terminal";
	if (key.startsWith("agent_commands.")) return key.slice("agent_commands.".length);
	return "";
}

/**
 * The keys to move from the plugin settings of 8.0.2 and 8.0.3 into the vault's config
 * file: the values that differ from the old defaults, for keys the file does not set.
 */
export function legacyPreferences(saved: Record<string, unknown> | null, vault: Preferences | null): [string, string][] {
	if (!saved) return [];
	const out: [string, string][] = [];
	const take = (key: string, value: unknown, old: string) => {
		const v = typeof value === "string" ? value.trim() : "";
		if (v && v !== old && !preference(vault, key)) out.push([key, v]);
	};
	take("agent_commands.claude", saved.agentCommand, "claude");
	if ((TERMINALS as readonly string[]).includes(String(saved.terminal))) take("terminal", saved.terminal, "terminal");
	if (String(saved.terminalCommand ?? "").includes("{command}")) take("terminal_command", saved.terminalCommand, "");
	return out;
}

/** The app bundle a terminal needs, by name; Terminal comes with macOS, and custom names its own program. */
export const TERMINAL_APPS: Partial<Record<TerminalApp, string>> = { iterm: "iTerm.app", wezterm: "WezTerm.app", ghostty: "Ghostty.app" };

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

/** Text with its wikilinks as plain titles: "[[A|b]]" reads "b", "[[A]]" reads "A". */
export function plainLinks(text: string): string {
	return text.replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, target: string, alias?: string) => (alias ?? target).split("#")[0]);
}

/** A thread's fields, as its stub holds them. */
export interface ThreadFields {
	status: string;
	tasks: string;
	blocked: string;
}

/** Where a thread stands, in a word or two, for a session's card. */
export function threadStage(t: ThreadFields): string {
	if (t.blocked) return "blocked";
	switch (t.status) {
		case "stub":
			return "needs spec";
		case "specified":
			return "writing tasks";
		case "planned":
			return "ready";
		case "started":
			return t.tasks ? `tasks ${t.tasks}` : "started";
		case "unverified":
			return "verifying";
		case "verified":
			return "to close";
		default:
			return t.status;
	}
}
