// Pure functions: no Obsidian, no Node. The tests cover them.

export interface Synced {
	threads?: string[] | null;
	lost?: string[] | null;
	sessions?: string[] | null;
	scopes?: string[] | null;
	settings?: boolean;
}

export interface SessionFields {
	harness?: string;
	harness_id?: string;
	cwd?: string;
}

/**
 * The places to look for the binary, in order, after the setting: the ones the agent
 * plugin's wrapper uses. PATH and the system folders are left out, so another tool's
 * binary never runs in its place.
 */
export function binaryCandidates(home: string): string[] {
	return [`${home}/.atlas/bin/atlas-obsidian`, `${home}/go/bin/atlas-obsidian`];
}

/** The override when it is set, else the first candidate that exists. */
export function chooseBinary(
	override: string,
	candidates: string[],
	exists: (path: string) => boolean,
	home: string,
): string | null {
	const set = override.trim();
	if (set !== "") return expandHome(set, home);
	return candidates.find(exists) ?? null;
}

export function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return home + path.slice(1);
	return path;
}

/** The message after "atlas: " on the last line of stderr that has one. */
export function errorMessage(stderr: string): string {
	const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l !== "");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].startsWith("atlas: ")) return lines[i].slice("atlas: ".length);
	}
	return lines[lines.length - 1] ?? "";
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** One line for a sync result. */
export function syncSummary(s: Synced): string {
	const parts: string[] = [];
	const threads = s.threads?.length ?? 0;
	const lost = s.lost?.length ?? 0;
	const sessions = s.sessions?.length ?? 0;
	if (threads) parts.push(plural(threads, "thread document", "thread documents"));
	if (lost) parts.push(plural(lost, "lost session", "lost sessions"));
	if (sessions) parts.push(plural(sessions, "session callout", "session callouts"));
	const scopes = s.scopes?.length ?? 0;
	if (scopes) parts.push(plural(scopes, "wiki page", "wiki pages"));
	if (s.settings) parts.push("the harness settings");
	if (parts.length === 0) return "Nothing to heal.";
	return `Synced ${parts.join(", ")}.`;
}

/** Every path a sync wrote. */
export function syncedPaths(s: Synced): string[] {
	return [...(s.threads ?? []), ...(s.lost ?? []), ...(s.sessions ?? []), ...(s.scopes ?? [])];
}

/**
 * The counts of a change without the zeros. The frontmatter holds a string such as
 * "3 create, 1 modify, 0 rename, 0 remove, 2 link rewrites"; a Preview holds an object.
 */
export function countsLine(counts: unknown): string {
	if (typeof counts === "string") {
		return counts
			.split(",")
			.map((p) => p.trim())
			.filter((p) => p !== "" && !/^0\s/.test(p))
			.join(", ");
	}
	if (counts && typeof counts === "object") {
		const names: Record<string, string> = {
			create: "create",
			modify: "modify",
			rename: "rename",
			remove: "remove",
			link_rewrites: "link rewrites",
		};
		return Object.entries(names)
			.map(([key, name]) => [(counts as Record<string, unknown>)[key], name] as const)
			.filter(([n]) => typeof n === "number" && n > 0)
			.map(([n, name]) => `${n} ${name}`)
			.join(", ");
	}
	return "";
}

/** "just now", "3 min ago", "2 h ago", "4 days ago". Empty when the time does not parse. */
export function formatAgo(when: string | Date | undefined, now: Date): string {
	if (when === undefined || when === "") return "";
	const t = when instanceof Date ? when : new Date(String(when));
	if (Number.isNaN(t.getTime())) return "";
	const s = Math.max(0, Math.floor((now.getTime() - t.getTime()) / 1000));
	if (s < 60) return "just now";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h} h ago`;
	const d = Math.floor(h / 24);
	return d === 1 ? "1 day ago" : `${d} days ago`;
}

/** "[[Title|alias]]" or "[[Title#heading]]" to "Title"; plain text stays. */
export function linkTitle(value: unknown): string {
	if (typeof value !== "string") return "";
	const m = /^\s*\[\[([^\]|#]*)(?:[#|][^\]]*)?\]\]\s*$/.exec(value);
	return (m ? m[1] : value).trim();
}

/** A list property as strings; a single string is a list of one. */
export function asList(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
	if (typeof value === "string" && value !== "") return [value];
	return [];
}

/** The last non-empty line of the "## Progress" section, without its list marker. */
export function lastProgressLine(markdown: string): string {
	let inside = false;
	let last = "";
	for (const raw of markdown.split("\n")) {
		const line = raw.trim();
		if (/^#{1,6}\s/.test(line)) {
			if (inside) break;
			inside = /^##\s+Progress\s*$/i.test(line);
			continue;
		}
		if (inside && line !== "") last = line.replace(/^[-*+]\s+(\[.\]\s+)?/, "");
	}
	return last;
}

export interface SessionRow {
	status: string;
	updated: string;
}

/** Waiting first, then the most recently updated. */
export function compareSessions(a: SessionRow, b: SessionRow): number {
	const rank = (s: string) => (s === "waiting" ? 0 : 1);
	if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
	return String(b.updated).localeCompare(String(a.updated));
}

/** A string as one POSIX shell word. */
export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A string as an AppleScript string literal. */
export function appleScriptString(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The shell command that resumes a session in its folder, or null without an id. */
export function resumeCommand(session: SessionFields, home: string): string | null {
	const id = session.harness_id?.trim();
	if (!id) return null;
	const resume =
		session.harness === "codex"
			? `codex resume ${shellQuote(id)}`
			: `claude --resume ${shellQuote(id)}`;
	const cwd = session.cwd?.trim();
	if (!cwd) return resume;
	return `cd ${shellQuote(expandHome(cwd, home))} && ${resume}`;
}

/** The osascript arguments that run a command in a new Terminal window. */
export function terminalArgs(command: string): string[] {
	return [
		"-e",
		`tell application "Terminal" to do script ${appleScriptString(command)}`,
		"-e",
		'tell application "Terminal" to activate',
	];
}

const TASK_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[.\]\s/;
const MENTION = /@atlas(?![\w-])/g;

/** The [from, to) offsets of each "@atlas" in a task line; none in any other line. */
export function mentionRanges(line: string): [number, number][] {
	if (!TASK_LINE.test(line)) return [];
	return textMentions(line);
}

/** The [from, to) offsets of each "@atlas" that does not continue a word. */
export function textMentions(text: string): [number, number][] {
	const out: [number, number][] = [];
	for (const m of text.matchAll(MENTION)) {
		const i = m.index ?? 0;
		if (i > 0 && /[\w@.]/.test(text[i - 1])) continue;
		out.push([i, i + m[0].length]);
	}
	return out;
}

export function isThreadPath(path: string): boolean {
	return path.startsWith("threads/") && path.endsWith(".md");
}

export function waitingLabel(n: number): string {
	return n === 1 ? "Atlas: 1 session waits" : `Atlas: ${n} sessions wait`;
}

function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function dirName(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

/** The page that would make a folder of the wiki a scope: wiki/…/X/X.md; null outside the wiki. */
export function folderPagePath(folder: string): string | null {
	if (!folder.startsWith("wiki/")) return null;
	return `${folder}/${baseName(folder)}.md`;
}

/** Whether a path is the page of its own folder under the wiki. */
export function isFolderPage(path: string): boolean {
	return folderPagePath(dirName(path)) === path;
}

/**
 * The rename that keeps a scope folder and its page in step after the user renamed one of
 * them: a renamed folder renames its page, a renamed page renames its folder. null when
 * nothing needs to follow.
 */
export function companionRename(isFolder: boolean, path: string, oldPath: string): { from: string; to: string } | null {
	if (!path.startsWith("wiki/")) return null;
	if (isFolder) {
		const oldName = baseName(oldPath);
		const name = baseName(path);
		if (oldName === name) return null;
		return { from: `${path}/${oldName}.md`, to: `${path}/${name}.md` };
	}
	if (!isFolderPage(oldPath) || dirName(path) !== dirName(oldPath) || !path.endsWith(".md")) return null;
	const folder = dirName(path);
	const name = baseName(path).slice(0, -3);
	if (name === "" || name === baseName(folder)) return null;
	return { from: folder, to: `${dirName(folder)}/${name}` };
}

/** A CSS string literal of s. */
export function cssString(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ")}"`;
}
