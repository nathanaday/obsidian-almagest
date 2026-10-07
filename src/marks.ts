// The marks of a wikified copy, and what each decision writes in their place. Pure: the
// tests cover it. The binary places the marks (internal/wikify); the plugin reads them as
// the binary does, so a mark in code or a comment is text.

export type MarkKind = "link" | "new";
export type Decision = "accept" | "ignore" | "link";

/** One mark: `{{link:<Title>|<phrase>}}` or `{{new:<Title>|<phrase>}}`. */
export interface Mark {
	/** The offsets of the whole mark in the text, in UTF-16 units, as the editor counts. */
	from: number;
	to: number;
	kind: MarkKind;
	title: string;
	phrase: string;
	/** The mark as the text holds it. */
	text: string;
}

const MARK = /\{\{(link|new):([^{}|\r\n]+)\|([^{}|\r\n]+)\}\}/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /`+[^`\n]*`+/g;
const COMMENT = /%%[\s\S]*?%%|<!--[\s\S]*?-->/g;
const FRONTMATTER = /^---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** The text with its code, comments, and frontmatter blanked; offsets and lines stay. */
export function mask(text: string): string {
	const lines = text.split(/(?<=\n)/);
	let fence = "";
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const bare = line.replace(/\r?\n$/, "");
		const open = FENCE.exec(bare);
		if (open) {
			const trimmed = bare.trim();
			if (fence === "") {
				fence = open[1]!;
				lines[i] = blank(line);
				continue;
			}
			if (trimmed.startsWith(fence[0]!) && trimmed.length >= fence.length && [...trimmed].every((c) => c === fence[0])) {
				fence = "";
				lines[i] = blank(line);
				continue;
			}
		}
		lines[i] = fence !== "" ? blank(line) : line.replace(INLINE_CODE, blank);
	}
	const out = lines.join("").replace(COMMENT, blank);
	const front = FRONTMATTER.exec(out);
	return front ? blank(front[0]) + out.slice(front[0].length) : out;
}

function blank(s: string): string {
	return s.replace(/[^\r\n]/g, " ");
}

/** The marks of a text in order, outside code, comments, and frontmatter. */
export function findMarks(text: string): Mark[] {
	const masked = mask(text);
	const out: Mark[] = [];
	for (const m of masked.matchAll(MARK)) {
		const from = m.index;
		out.push({ from, to: from + m[0].length, kind: m[1] as MarkKind, title: m[2]!, phrase: m[3]!, text: m[0] });
	}
	return out;
}

/** The mark that the whole of s is, or null. */
export function parseMark(s: string): Omit<Mark, "from" | "to"> | null {
	const m = new RegExp(`^${MARK.source}$`).exec(s);
	return m ? { kind: m[1] as MarkKind, title: m[2]!, phrase: m[3]!, text: s } : null;
}

/** The link a mark becomes: `[[Title]]` when the phrase is the title as written, else `[[Title|phrase]]`, so the note keeps its own spelling. */
export function linkFor(m: { title: string; phrase: string }): string {
	return m.title === m.phrase ? `[[${m.title}]]` : `[[${m.title}|${m.phrase}]]`;
}

/** What a decision writes in a mark's place: Accept and Link write the link; Ignore writes the phrase. */
export function replacement(m: { title: string; phrase: string }, decision: Decision): string {
	return decision === "ignore" ? m.phrase : linkFor(m);
}

/**
 * The nth mark of a text whose text is markText, among the marks from line `lines.start`
 * to line `lines.end` (0-based, inclusive) when lines is given; or null.
 */
export function locate(text: string, markText: string, nth = 0, lines?: { start: number; end: number }): Mark | null {
	let marks = findMarks(text).filter((m) => m.text === markText);
	if (lines) {
		const lineOf = lineCounter(text);
		marks = marks.filter((m) => {
			const line = lineOf(m.from);
			return line >= lines.start && line <= lines.end;
		});
	}
	return marks[nth] ?? null;
}

function lineCounter(text: string): (offset: number) => number {
	const starts = [0];
	for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
	return (offset) => {
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (starts[mid]! <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};
}

/** The text with one mark replaced by what the decision writes. */
export function decide(text: string, m: Mark, decision: Decision): string {
	return text.slice(0, m.from) + replacement(m, decision) + text.slice(m.to);
}

/** Accept on every link mark: the new text and how many marks it accepted. */
export function acceptAll(text: string): { text: string; count: number } {
	const marks = findMarks(text).filter((m) => m.kind === "link");
	let out = text;
	for (const m of [...marks].reverse()) out = decide(out, m, "accept");
	return { text: out, count: marks.length };
}

/** Whether a path is a copy that `wikify start` made: its name ends with " · wikified", or that and a number. */
export function isWikified(path: string): boolean {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return /\.md$/i.test(name) && / · wikified(?: \(\d+\))?$/.test(name.slice(0, -3));
}

const NOT_YOURS = ["source-core", "changes", "sessions", "wiki-view", "trash", ".obsidian"];

/** Why `wikify start` refuses a path, or "" when it takes it. */
export function wikifyBlocked(path: string): string {
	if (!/\.md$/i.test(path)) return "Wikify takes a markdown note.";
	if (path === "Atlas.md") return "Wikify takes a note of yours, not Atlas.md.";
	const top = path.split("/")[0]!;
	if (path.includes("/") && NOT_YOURS.includes(top)) return `Wikify takes a note of yours, not one in ${top}/.`;
	return "";
}

/** The topic title of a draft work document (`change start --kind draft --title "Draft <Title>"`), or null. */
export function draftTitle(changeTitle: string): string | null {
	const m = /^\d{4}-\d{2}-\d{2} Draft (.+?)(?: \(\d+\))?$/.exec(changeTitle);
	return m ? m[1]! : null;
}
