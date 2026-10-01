import { execFile, spawn } from "child_process";
import { closeSync, existsSync, openSync, readSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Launch, TerminalApp, configDirOf, firstCwd, terminalLaunch } from "./agents";

/** Opens a terminal that runs a command. Off macOS, the caller copies the command. */
export function openTerminal(app: TerminalApp, command: string, custom: string): Promise<void> {
	const launch: Launch = terminalLaunch(app, command, process.env.SHELL ?? "/bin/zsh", custom);
	return new Promise((resolve, reject) => {
		const child = spawn(launch.program, launch.args, { detached: true, stdio: "ignore" });
		child.once("error", reject);
		// A terminal that starts stays running; an error comes at once or not at all.
		child.once("spawn", () => {
			child.unref();
			window.setTimeout(resolve, 300);
		});
	});
}

/** The ids of the processes that run and are agents: claude or codex. */
export function liveAgents(pids: number[]): Promise<Set<number>> {
	const list = [...new Set(pids.filter((p) => p > 1))];
	if (list.length === 0) return Promise.resolve(new Set());
	return new Promise((resolve) => {
		// ps exits 1 when one id is gone, and still prints the others.
		execFile("ps", ["-o", "pid=,comm=", "-p", list.join(",")], (_err, stdout) => {
			const out = new Set<number>();
			for (const line of String(stdout ?? "").split("\n")) {
				const m = /^\s*(\d+)\s+(.*)$/.exec(line);
				if (!m) continue;
				const name = m[2].trim().split("/").pop() ?? "";
				if (name === "claude" || name === "codex" || name.startsWith("claude-") || name.startsWith("codex-")) out.add(Number(m[1]));
			}
			resolve(out);
		});
	});
}

/** The config folders where Claude Code may keep conversations: ~/.claude*, and $CLAUDE_CONFIG_DIR. */
function configDirs(): string[] {
	const home = homedir();
	const out = new Set<string>();
	if (process.env.CLAUDE_CONFIG_DIR) out.add(process.env.CLAUDE_CONFIG_DIR);
	try {
		for (const name of readdirSync(home)) {
			if (name === ".claude" || name.startsWith(".claude-")) out.add(join(home, name));
		}
	} catch {
		// No home to read.
	}
	return [...out];
}

/** The transcript of a Claude Code session: the one the hooks recorded, else the file of that id. */
export function findTranscript(recorded: string, id: string): string {
	if (recorded && existsSync(recorded)) return recorded;
	if (!id) return "";
	for (const dir of configDirs()) {
		const projects = join(dir, "projects");
		let folders: string[] = [];
		try {
			folders = readdirSync(projects);
		} catch {
			continue;
		}
		for (const f of folders) {
			const file = join(projects, f, `${id}.jsonl`);
			if (existsSync(file)) return file;
		}
	}
	return "";
}

/** The folder a transcript says to resume in, and the config folder to name: "" for the default one. */
export function resumePlace(transcript: string): { cwd: string; configDir: string } {
	let head = "";
	try {
		const fd = openSync(transcript, "r");
		const buf = Buffer.alloc(256 * 1024);
		const n = readSync(fd, buf, 0, buf.length, 0);
		closeSync(fd);
		head = buf.subarray(0, n).toString("utf8");
	} catch {
		// Unreadable: the caller falls back to the session's own folder.
	}
	// Claude Code keys its login to the folder it was told; naming the default folder
	// explicitly asks for a login it does not have. Only another account's folder is named.
	const dir = configDirOf(transcript);
	return { cwd: firstCwd(head), configDir: dir === join(homedir(), ".claude") ? "" : dir };
}
