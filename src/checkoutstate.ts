// The librarian's checkouts as the palette shows them. Pure: the tests cover them.

export const CHECKOUT = "checkout";

/** The ledger: a Base of every checkout, out and returned. */
export const LEDGER = "checkout/Checkout · Ledger.md";

/** One checkout, as `vault --json` and `checkout --json` print it (checkout.Entry). */
export interface Checkout {
	/** The folder, from the vault's root: "checkout/2026-10-06 Alpha study", or "tool/returned/…" once returned. */
	folder: string;
	/** The name the librarian gave it: "Alpha study". */
	name: string;
	request: string;
	/** The day of the checkout: "2026-10-06". */
	date: string;
	documents: number;
	/** The copies whose body differs from the body as checked out. */
	edited: number;
	/** Out, in checkout/, or returned, in tool/returned/. */
	status: "out" | "returned";
	/** The time of the return, or "". */
	returned: string;
}

/** What `checkout return --json` prints under "returned". */
export interface Returned {
	change?: { ref: { id: string; title: string; path: string }; counts?: { modify?: number } } | null;
	/** The checkout's place in tool/returned/. */
	folder?: string;
	/** The copies left out, each "<file>: <why>". */
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
			name: c.name || folderName(c.folder!).replace(/^\d{4}-\d{2}-\d{2} /, ""),
			request: c.request || folderName(c.folder!),
			date: c.date ?? "",
			documents: c.documents ?? 0,
			edited: c.edited ?? 0,
			status: c.status === "returned" ? ("returned" as const) : ("out" as const),
			returned: c.returned ?? "",
		}))
		.sort((a, b) => (a.folder < b.folder ? 1 : a.folder > b.folder ? -1 : 0));
}

/** The checkouts that are out. */
export function outOnly(list: Checkout[]): Checkout[] {
	return list.filter((c) => c.status === "out");
}

/** The checkouts out with edited copies: their edits reach the wiki only through a return. */
export function toReturn(list: Checkout[]): number {
	return list.filter((c) => c.status === "out" && c.edited > 0).length;
}

/** The day of a time the binary wrote: "2026-10-06T18:00:34" gives "2026-10-06". */
export function day(stamp: string): string {
	return stamp.slice(0, 10);
}

/** The checkout's index: its name, request, status, and reading order. */
export function indexPath(c: Checkout): string {
	return `${c.folder}/_index.md`;
}

/** The folder's own name: "checkout/2026-10-06 Alpha study" gives "2026-10-06 Alpha study". */
export function folderName(folder: string): string {
	return folder.slice(folder.lastIndexOf("/") + 1);
}

/** What a return did, for its notice: where the checkout went, and the change of its edits, if any. */
export function returnedLine(name: string, r: Returned): string {
	const edits = r.change?.counts?.modify ?? 0;
	const change = r.change?.ref
		? `${r.change.ref.title} proposes your edits to ${edits === 1 ? "1 document" : `${edits} documents`}; approve it in the change.`
		: "No copy was edited, so nothing changes in the wiki.";
	return `Returned ${name} to ${r.folder ?? "tool/returned/"}. ${change}`;
}

/** The line of a notice that names the copies a return left out, or "" when it left none. */
export function skippedLine(skipped: string[] | null | undefined): string {
	const list = skipped ?? [];
	if (list.length === 0) return "";
	return `the return left out ${list.length === 1 ? "1 copy" : `${list.length} copies`}, whose edits stay in the returned copies: ${list.join("; ")}.`;
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
