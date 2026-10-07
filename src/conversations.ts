// The agents the palette started through Duet, while their first turn runs. Pure: Duet's
// API comes in, so the tests drive it with a fake.

import type { ConversationStatus, DuetApi, TurnEnd } from "./duet";

/** Duet's API when Duet is on and gives version 1 or later. Read it at each call: the user can turn Duet off. */
export function duetApi(app: unknown): DuetApi | undefined {
	const plugins = (app as { plugins?: { getPlugin?(id: string): { api?: unknown } | null } } | null)?.plugins;
	const api = plugins?.getPlugin?.("duet")?.api as Partial<DuetApi> | undefined;
	if (!api || typeof api.version !== "number" || api.version < 1) return undefined;
	if (typeof api.newConversation !== "function" || typeof api.conversationStatus !== "function" || typeof api.onTurnEnd !== "function") return undefined;
	return api as DuetApi;
}

export interface Conversation {
	/** The conversation note; it follows a rename. */
	path: string;
	/** What the agent does, as the palette names it. */
	label: string;
}

interface Followed {
	conversation: Conversation;
	stop: () => void;
}

export class Conversations {
	private followed: Followed[] = [];

	constructor(
		private changed: () => void,
		private ended: (c: Conversation, turn: TurnEnd) => void = () => {},
	) {}

	/**
	 * Lists a conversation until its turn ends. It subscribes before it reads the status, so
	 * a turn that ends in between is not missed: the status then says the turn is over.
	 */
	follow(api: DuetApi, path: string, label: string): void {
		const item: Followed = { conversation: { path, label }, stop: () => {} };
		item.stop = api.onTurnEnd(path, (turn) => {
			item.conversation.path = turn.path;
			if (this.drop(item)) this.ended(item.conversation, turn);
		});
		if (status(api, path) !== "working") {
			item.stop();
			return;
		}
		this.followed.push(item);
		this.changed();
	}

	/** Drops each conversation that no longer works: ended, gone, or with Duet off. */
	check(api: DuetApi | undefined): void {
		for (const item of [...this.followed]) {
			if (!api || status(api, item.conversation.path) !== "working") this.drop(item);
		}
	}

	list(): Conversation[] {
		return this.followed.map((f) => ({ ...f.conversation }));
	}

	stop(): void {
		for (const f of this.followed) f.stop();
		this.followed = [];
	}

	private drop(item: Followed): boolean {
		const i = this.followed.indexOf(item);
		if (i < 0) return false;
		this.followed.splice(i, 1);
		item.stop();
		this.changed();
		return true;
	}
}

/** The status, or "none" when an API of a Duet that turned off throws. */
function status(api: DuetApi, path: string): ConversationStatus {
	try {
		return api.conversationStatus(path);
	} catch {
		return "none";
	}
}
