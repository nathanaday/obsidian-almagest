// Opens a real terminal the way Start agent does, with a probe in place of the agent.
// The probe checks that the agent command resolves in the user's shell, and records
// the folder it ran in. It starts no agent session and spends nothing.
//
// Usage: node scripts/probe-launch.mjs TERMINAL [AGENT_COMMAND] [CUSTOM_TEMPLATE]
//   TERMINAL is terminal, iterm, wezterm, ghostty, or custom.
//   AGENT_COMMAND is what the config gives, such as claude or claude-work.
// Record the result in TESTED.md.
import esbuild from "esbuild";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [terminal, agent = "claude", custom = ""] = process.argv.slice(2);
if (!terminal) {
	console.error("usage: node scripts/probe-launch.mjs TERMINAL [AGENT_COMMAND] [CUSTOM_TEMPLATE]");
	process.exit(2);
}

const bundle = await esbuild.build({ entryPoints: ["src/agents.ts"], bundle: true, format: "esm", platform: "node", write: false });
const url = "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64");
const { startCommand, terminalLaunch } = await import(url);

const dir = mkdtempSync(join(tmpdir(), "atlas-probe-"));
const out = join(dir, "probe.txt");
const program = agent.split(/\s+/)[0];
// The probe stands where the agent command goes.
const probe = `{ print agent=$(whence -w ${program} || type ${program}); ${agent} --version; print cwd=$PWD; } >${out} 2>&1; exit`;
const launch = terminalLaunch(terminal, startCommand(dir, probe), process.env.SHELL ?? "/bin/zsh", custom);
spawn(launch.program, launch.args, { detached: true, stdio: "ignore" }).unref();

for (let i = 0; i < 30 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 1000));
await new Promise((r) => setTimeout(r, 2000));
if (!existsSync(out)) {
	console.error(`FAIL: ${terminal} wrote nothing in 30 seconds. Look at the terminal window for an error.`);
	process.exit(1);
}
// Strip the terminal escapes a shell function may print.
const text = readFileSync(out, "utf8").replace(/\x1b\][^\x07]*\x07/g, "");
console.log(text.trim());
const ok = text.includes(`cwd=${dir}`) || text.includes(`cwd=/private${dir}`);
console.log(ok ? `PASS: ${terminal} ran ${agent} in the folder` : `FAIL: ${terminal} did not run in ${dir}`);
process.exit(ok ? 0 : 1);
