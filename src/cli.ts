import { execFile } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { Notice } from "obsidian";
import { binaryCandidates, chooseBinary, errorMessage, movedNotices } from "./helpers";

export class AtlasError extends Error {}

/** The binary to run: the setting, else the first known place that has one. */
export function findBinary(override: string): string | null {
	const home = homedir();
	return chooseBinary(override, binaryCandidates(home), existsSync, home);
}

// Obsidian started from the Dock gets a short PATH; the binary runs git.
function childEnv(): NodeJS.ProcessEnv {
	const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
	const path = [process.env.PATH ?? "", ...extra].filter((p) => p !== "").join(":");
	return { ...process.env, PATH: path };
}

/** Runs a program; an exit code in answers is an answer on stdout, not a failure. */
function exec(bin: string, args: string[], cwd: string | undefined, answers: number[] = []): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			bin,
			args,
			{ cwd, env: childEnv(), maxBuffer: 32 * 1024 * 1024, timeout: 5 * 60 * 1000 },
			(err, stdout, stderr) => {
				if (!err) return resolve(stdout);
				const code = (err as NodeJS.ErrnoException).code as unknown;
				if (typeof code === "number" && answers.includes(code)) return resolve(stdout);
				if (code === "ENOENT") {
					return reject(new AtlasError(`the atlas-obsidian binary was not found at ${bin}`));
				}
				reject(new AtlasError(errorMessage(String(stderr)) || err.message));
			},
		);
	});
}

/**
 * Runs one atlas command in the vault and returns its JSON output. answers lists the exit
 * codes that print an answer too, such as 2 of vault trash for a file that others link.
 */
export async function runAtlas<T>(bin: string | null, vault: string, args: string[], answers: number[] = []): Promise<T> {
	if (!bin) throw new AtlasError("the atlas-obsidian binary was not found; set its path in the Atlas settings");
	const out = await exec(bin, [...args, "--vault", vault, "--json"], vault, answers);
	let parsed: T;
	try {
		parsed = JSON.parse(out) as T;
	} catch {
		throw new AtlasError(`atlas-obsidian ${args[0]} did not print JSON`);
	}
	// A write that moved a note of the user's out of wiki-view/ says where it went, whichever
	// button ran it.
	for (const line of movedNotices(parsed)) new Notice(`Atlas: ${line}`, 0);
	return parsed;
}

/** The version line the binary prints, such as "atlas-obsidian 10.0.0". */
export async function binaryVersion(bin: string): Promise<string> {
	return (await exec(bin, ["version"], undefined)).trim();
}

/** Runs a program with its arguments; for osascript. */
export function runProgram(bin: string, args: string[]): Promise<string> {
	return exec(bin, args, undefined);
}
