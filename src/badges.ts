import { App, Component, TFile, debounce } from "obsidian";

const BADGE = "atlas-badge";

/** The badge for a document: a thread's or a chord's status, an event's kind, a session's status. */
function badgeFor(app: App, path: string): { kind: string; value: string } | null {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile) || file.extension !== "md") return null;
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	if (!fm) return null;
	if ((fm.type === "stub" || fm.type === "chord") && typeof fm.status === "string") {
		return { kind: "status", value: fm.blocked ? "blocked" : fm.status };
	}
	if (fm.type === "event" && typeof fm.kind === "string") return { kind: "event", value: fm.kind };
	if (fm.type === "session" && typeof fm.status === "string") return { kind: "status", value: fm.status };
	return null;
}

function ownMutation(m: MutationRecord): boolean {
	const inBadge = (n: Node) =>
		n instanceof Element ? n.classList.contains(BADGE) || n.closest(`.${BADGE}`) !== null : n.parentElement?.closest(`.${BADGE}`) != null;
	const nodes = [...Array.from(m.addedNodes), ...Array.from(m.removedNodes)];
	return inBadge(m.target) || (nodes.length > 0 && nodes.every(inBadge));
}

/**
 * Badges in the file explorer. The explorer's DOM is not public API, so every step
 * tolerates a missing element: no explorer, no badges.
 */
export class Badges extends Component {
	private observers: MutationObserver[] = [];
	private observed: HTMLElement[] = [];
	private enabled = false;
	readonly refresh = debounce(() => this.apply(), 300, true);

	constructor(private app: App) {
		super();
	}

	onload(): void {
		this.registerEvent(this.app.metadataCache.on("changed", () => this.refresh()));
		this.registerEvent(this.app.vault.on("rename", () => this.refresh()));
		this.registerEvent(this.app.vault.on("delete", () => this.refresh()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.refresh()));
		this.app.workspace.onLayoutReady(() => this.refresh());
	}

	onunload(): void {
		this.disconnect();
		this.clear();
	}

	setEnabled(on: boolean): void {
		this.enabled = on;
		if (on) this.refresh();
		else {
			this.disconnect();
			this.clear();
		}
	}

	private explorers(): HTMLElement[] {
		return this.app.workspace.getLeavesOfType("file-explorer").map((leaf) => leaf.view.containerEl);
	}

	private apply(): void {
		if (!this.enabled) return;
		this.observe();
		for (const root of this.explorers()) {
			root.querySelectorAll<HTMLElement>(".nav-file-title[data-path]").forEach((title) => {
				const path = title.getAttribute("data-path") ?? "";
				const badge = badgeFor(this.app, path);
				let span = title.querySelector<HTMLElement>(`:scope > .${BADGE}`);
				if (!badge) {
					span?.remove();
					return;
				}
				if (!span) span = title.createSpan({ cls: BADGE });
				if (span.dataset.kind !== badge.kind) span.dataset.kind = badge.kind;
				if (span.dataset.value !== badge.value) span.dataset.value = badge.value;
				if (span.textContent !== badge.value) span.textContent = badge.value;
			});
		}
	}

	// A folder opened in the explorer renders new rows without a workspace event.
	private observe(): void {
		const roots = this.explorers();
		if (roots.length === this.observed.length && roots.every((r, i) => r === this.observed[i])) return;
		this.disconnect();
		this.observed = roots;
		for (const root of roots) {
			const o = new MutationObserver((records) => {
				if (records.every(ownMutation)) return;
				this.refresh();
			});
			o.observe(root, { childList: true, subtree: true });
			this.observers.push(o);
		}
	}

	private disconnect(): void {
		this.observers.forEach((o) => o.disconnect());
		this.observers = [];
		this.observed = [];
	}

	private clear(): void {
		for (const root of this.explorers()) {
			root.querySelectorAll(`.${BADGE}`).forEach((el) => el.remove());
		}
	}
}
