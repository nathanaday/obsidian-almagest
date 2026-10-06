import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AgentConfig,
	SessionRow,
	inherited,
	legacyPreferences,
	preference,
	appleScriptString,
	configDirOf,
	firstCwd,
	groupSessions,
	resumeCommand,
	shellQuote,
	startCommand,
	terminalLaunch,
	plainLinks,
} from "../src/agents";

const now = new Date("2026-10-01T12:00:00");
const row = (path: string, status: string, updated: string, extra: Partial<SessionRow> = {}): SessionRow => ({
	path, status, updated, ended: "", pid: 0, parent: "", ...extra,
});

test("the pane keeps an open session while it pauses, and orders by what the user must do", () => {
	const alive = (pid: number) => pid === 11 || pid === 12 || pid === 13;
	const g = groupSessions(
		[
			row("idle", "idle", "2026-10-01T11:50:00", { pid: 11 }),
			row("working", "running", "2026-10-01T11:40:00", { pid: 12 }),
			row("asks", "waiting", "2026-10-01T11:00:00", { pid: 13 }),
			row("gone", "idle", "2026-10-01T11:55:00", { pid: 99 }),
			row("ended", "ended", "2026-10-01T11:30:00", { ended: "2026-10-01T11:30:00" }),
			row("old", "ended", "2026-09-30T09:00:00", { ended: "2026-09-30T09:00:00" }),
			row("child", "running", "2026-10-01T11:59:00", { pid: 12, parent: "[[working]]" }),
			row("before pids", "idle", "2026-10-01T08:00:00"),
			row("stale", "running", "2026-09-29T08:00:00"),
		],
		alive,
		now,
		12,
	);
	assert.deepEqual(g.open.map((s) => `${s.row.path}:${s.state}`), ["asks:needs you", "working:working", "idle:idle", "before pids:idle"]);
	assert.deepEqual(g.recent.map((s) => `${s.row.path}:${s.state}`), ["gone:ended", "ended:ended"], "a session whose process is gone is ended");
	assert.equal(g.older, 2);
});

test("resume runs in the conversation's folder and account", () => {
	assert.equal(configDirOf("/Users/a/.claude-work/projects/-Users-a-v/abc.jsonl"), "/Users/a/.claude-work");
	assert.equal(configDirOf("abc.jsonl"), "");
	assert.equal(firstCwd('{"type":"mode"}\n{"type":"user","cwd":"/Users/a/v"}\n{"cwd":"/x"}\n{"cut'), "/Users/a/v");
	assert.equal(firstCwd('{"type":"mode"}'), "");
	assert.equal(
		resumeCommand({ harness: "claude", id: "abc-1", cwd: "/Users/a/it's here", configDir: "/Users/a/.claude-work" }),
		`cd '/Users/a/it'\\''s here' && export CLAUDE_CONFIG_DIR='/Users/a/.claude-work' && claude --resume 'abc-1'`,
	);
	assert.equal(resumeCommand({ harness: "codex", id: "x", cwd: "/w", configDir: "" }), `cd '/w' && codex resume 'x'`);
	assert.equal(resumeCommand({ harness: "claude", id: "x", cwd: "", configDir: "" }), `claude --resume 'x'`);
});

test("start runs the user's agent command in the vault", () => {
	assert.equal(startCommand("/v/My vault", "claude"), `cd '/v/My vault' && claude`);
	assert.equal(startCommand("/v", " "), `cd '/v' && claude`);
	assert.equal(startCommand("/v", " my-claude --model x "), `cd '/v' && my-claude --model x`);
});

test("each terminal runs the command in an interactive shell", () => {
	assert.equal(shellQuote("a'b"), `'a'\\''b'`);
	assert.equal(appleScriptString(`say "hi" \\ bye`), `"say \\"hi\\" \\\\ bye"`);
	const cmd = `cd '/a "b"' && claude 'x'`;
	assert.equal(terminalLaunch("terminal", cmd, "/bin/zsh", "").args[1], `tell application "Terminal" to do script "cd '/a \\"b\\"' && claude 'x'"`);
	assert.ok(terminalLaunch("iterm", cmd, "/bin/zsh", "").args[3].includes("write text"));
	const wez = terminalLaunch("wezterm", cmd, "/bin/zsh", "");
	assert.deepEqual(wez.args, ["start", "--", "/bin/zsh", "-lic", `${cmd}; exec /bin/zsh -l`]);
	assert.deepEqual(terminalLaunch("ghostty", cmd, "", "").args.slice(0, 5), ["-na", "Ghostty", "--args", "-e", "/bin/zsh"]);
	assert.deepEqual(terminalLaunch("custom", "echo 'hi'", "", "kitty sh -c {command}").args, ["-c", `kitty sh -c 'echo '\\''hi'\\'''`]);
});

test("a card shows links as titles", () => {
	assert.equal(plainLinks("Write the spec of [[Raw U16 format]]: then [[A#h|the a]]."), "Write the spec of Raw U16 format: then the a.");
});

test("inherited: the global value, else the default", () => {
	const config = {
		preferences: {} as AgentConfig["preferences"],
		global: { terminal: "wezterm", agent_commands: { codex: "codex --full-auto" } },
		vault: { agent_commands: { claude: "claude-work" } },
		files: { global: "~/.atlas/config.json" },
	} as AgentConfig;
	assert.equal(inherited(config, "terminal"), "wezterm");
	assert.equal(inherited(config, "agent"), "claude");
	assert.equal(inherited(config, "agent_commands.claude"), "claude", "the vault's own value is not inherited");
	assert.equal(inherited(config, "agent_commands.codex"), "codex --full-auto");
	assert.equal(preference(config.vault, "agent_commands.claude"), "claude-work");
	assert.equal(preference(null, "terminal"), "");
});

test("legacyPreferences moves only the changed settings the vault file lacks", () => {
	assert.deepEqual(legacyPreferences({ agentCommand: "claude", terminal: "terminal", terminalCommand: "" }, null), []);
	assert.deepEqual(legacyPreferences({ agentCommand: "claude-work", terminal: "wezterm", terminalCommand: "kitty {command}" }, null), [
		["agent_commands.claude", "claude-work"],
		["terminal", "wezterm"],
		["terminal_command", "kitty {command}"],
	]);
	assert.deepEqual(legacyPreferences({ agentCommand: "claude-work", terminal: "wezterm" }, { terminal: "iterm" }), [["agent_commands.claude", "claude-work"]]);
	assert.deepEqual(legacyPreferences({ terminal: "kitty", terminalCommand: "kitty" }, null), [], "bad values stay behind");
	assert.deepEqual(legacyPreferences(null, null), []);
});
