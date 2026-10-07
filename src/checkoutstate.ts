// The librarian's checkouts as the palette shows them. Pure: the tests cover them.

export const CHECKOUT = "checkout";

/** One checkout, as `vault --json` and `checkout --json` print it (checkout.Entry). */
export interface Checkout {
	/** The folder, from the vault's root: "checkout/2026-10-06 Alpha study". */
	folder: string;
	request: string;
	/** The day of the checkout: "2026-10-06". */
	date: string;
	documents: number;
	/** The copies whose body differs from the body as checked out. */
	edited: number;
	/** The time of the return, or "". */
	returned: string;
}

/** What `checkout return --json` prints under "returned". */
export interface Returned {
	change?: { ref: { id: string; title: string; path: string } } | null;
	/** The copies left out, each "<path>: <why>". */
	skipped?: string[] | null;
	/** What went wrong after the change was proposed. */
	warning?: string;
}

/** The checkouts, newest first (a folder's name begins with its date), with any missing field filled. */
export function checkouts(list: Partial<Checkout>[] | null | undefined): Checkout[] {
	return (list ?? [])
		.filter((c) => typeof c.folder === "string" && c.folder !== "")
		.map((c) => ({
			folder: c.folder!,
			request: c.request || folderName(c.folder!),
			date: c.date ?? "",
			documents: c.documents ?? 0,
			edited: c.edited ?? 0,
			returned: c.returned ?? "",
		}))
		.sort((a, b) => (a.folder < b.folder ? 1 : a.folder > b.folder ? -1 : 0));
}

/** The checkouts with edited copies that no return took yet. */
export function toReturn(list: Checkout[]): number {
	return list.filter((c) => returnBlocked(c) === "").length;
}

/** Why Return is off for a checkout, or "" when it can return. */
export function returnBlocked(c: Checkout): string {
	if (c.returned) return `Returned ${day(c.returned)}.`;
	if (c.edited === 0) return "No copy is edited.";
	return "";
}

/** The day of a time the binary wrote: "2026-10-06T18:00:34" gives "2026-10-06". */
export function day(stamp: string): string {
	return stamp.slice(0, 10);
}

/** The reading list, "Checkout · <folder name>.md", a name no copy can take. */
export function readingListPath(c: Checkout): string {
	return `${c.folder}/Checkout · ${folderName(c.folder)}.md`;
}

/** The folder's own name: "checkout/2026-10-06 Alpha study" gives "2026-10-06 Alpha study". */
export function folderName(folder: string): string {
	return folder.slice(folder.lastIndexOf("/") + 1);
}

/** The line of a notice that names the copies a return left out, or "" when it left none. */
export function skippedLine(skipped: string[] | null | undefined): string {
	const list = skipped ?? [];
	if (list.length === 0) return "";
	return `the return left out ${list.length === 1 ? "1 copy" : `${list.length} copies`}: ${list.join("; ")}.`;
}

/** The request as one line: Checkout's first message holds no line break. */
export function oneLine(request: string): string {
	return request.trim().replace(/\s+/g, " ");
}

const TITLE_MAX = 60;

/** The title of the librarian's conversation: "Agent · Check out <request>", the request cut at a word. */
export function checkoutTitle(request: string): string {
	let text = oneLine(request);
	if (text.length > TITLE_MAX) {
		const cut = text.slice(0, TITLE_MAX);
		const space = cut.lastIndexOf(" ");
		text = `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
	}
	return `Agent · Check out ${text}`;
}
