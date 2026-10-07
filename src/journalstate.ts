// The journal volumes and the titles of their editions. Pure: the tests cover them.

export const JOURNALS = "journals";

/** One volume, as `vault --json` and `journal --json` print it (journal.Volume). */
export interface JournalVolume {
	/** The folder directly under journals/. */
	volume: string;
	name: string;
	notes: number;
	/** The latest edition's title, or "". */
	edition: string;
	/** True when the notes differ from the latest edition, or no edition exists and the volume holds a note. */
	changed: boolean;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The separators of journal.Name: "-", "_", and the white space of Go's unicode.IsSpace. */
const SEPARATORS = /[-_\t\n\v\f\r\u0085\p{Zs}\u2028\u2029]+/u;

/**
 * How a volume's folder reads in an edition's title (journal.Name): "-" and "_" are
 * spaces; a word that mixes letters and digits is upper case, any other word starts with
 * a capital. "cs566-notes" is "CS566 Notes".
 */
export function journalName(folder: string): string {
	return folder
		.split(SEPARATORS)
		.filter((w) => w !== "")
		.map((w) => (/\p{L}/u.test(w) && /\p{Nd}/u.test(w) ? w.toUpperCase() : capital(w)))
		.join(" ");
}

function capital(word: string): string {
	const first = word.codePointAt(0);
	if (first === undefined) return word;
	const head = String.fromCodePoint(first);
	return head.toUpperCase() + word.slice(head.length);
}

/** The title of a volume's edition of a day (journal.Title): "User Journal CS566 Notes - 6 October 2026 Edition". */
export function editionTitle(folder: string, day: Date): string {
	return `User Journal ${journalName(folder)} - ${day.getDate()} ${MONTHS[day.getMonth()]} ${day.getFullYear()} Edition`;
}

/** The volumes, in the binary's order, with any missing field filled. */
export function journalVolumes(list: Partial<JournalVolume>[] | null | undefined): JournalVolume[] {
	return (list ?? [])
		.filter((v) => typeof v.volume === "string" && v.volume !== "")
		.map((v) => ({
			volume: v.volume!,
			name: v.name || journalName(v.volume!),
			notes: v.notes ?? 0,
			edition: v.edition ?? "",
			changed: v.changed === true,
		}));
}

/** The volumes with changes to publish. */
export function toPublish(volumes: JournalVolume[]): number {
	return volumes.filter((v) => v.changed).length;
}

/** Why Publish is off for a volume, or "" when it can publish. */
export function publishBlocked(v: JournalVolume): string {
	if (v.notes === 0) return "The volume holds no note.";
	if (!v.changed) return v.edition ? `No change since ${v.edition}.` : "No change to publish.";
	return "";
}

/** The volume a vault path lies in: "journals/<volume>/…" gives <volume>; any other path gives "". */
export function volumeOf(path: string): string {
	const parts = path.split("/");
	return parts.length >= 3 && parts[0] === JOURNALS && parts[1] !== "" && !parts[1].startsWith(".") ? parts[1] : "";
}

/**
 * Whether the edition of today takes a number: capture numbers a second edition of one
 * day, "… Edition (2)".
 */
export function numbered(latest: string, title: string): boolean {
	return latest === title || (latest.startsWith(`${title} (`) && latest.endsWith(")"));
}
