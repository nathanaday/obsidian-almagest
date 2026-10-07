import assert from "node:assert/strict";
import { test } from "node:test";
import { Conversations, duetApi } from "../src/conversations";
import type { ConversationStatus, DuetApi, TurnEnd } from "../src/duet";

/** A Duet that records what Atlas asks of it; the test ends turns by hand. */
function fakeDuet(initial: ConversationStatus = "working") {
	const status = new Map<string, ConversationStatus>();
	const listeners = new Map<string, ((t: TurnEnd) => void)[]>();
	const calls: string[] = [];
	const api: DuetApi = {
		version: 1,
		newConversation: async (o) => {
			const path = `Duet/${o.title}.md`;
			status.set(path, initial);
			return { path };
		},
		conversationStatus: (path) => {
			calls.push(`status ${path}`);
			return status.get(path) ?? "none";
		},
		onTurnEnd: (path, cb) => {
			calls.push(`subscribe ${path}`);
			listeners.set(path, [...(listeners.get(path) ?? []), cb]);
			return () => listeners.set(path, (listeners.get(path) ?? []).filter((x) => x !== cb));
		},
	};
	const end = (path: string, turn: Partial<TurnEnd> = {}) => {
		status.set(turn.path ?? path, "active");
		for (const cb of listeners.get(path) ?? []) cb({ path, status: "completed", ...turn });
	};
	return { api, status, listeners, calls, end };
}

test("a conversation stays in the list until its turn ends", async () => {
	const duet = fakeDuet();
	let changes = 0;
	const ended: string[] = [];
	const list = new Conversations(
		() => changes++,
		(c, t) => ended.push(`${c.label} ${t.status}`),
	);
	const { path } = await duet.api.newConversation({ message: "/x", title: "Agent · Ingest" });
	list.follow(duet.api, path, "ingest");
	assert.deepEqual(duet.calls, [`subscribe ${path}`, `status ${path}`], "it subscribes before it reads the status");
	assert.deepEqual(list.list(), [{ path, label: "ingest" }]);

	duet.end(path, { path: "Duet/Renamed.md" });
	assert.deepEqual(list.list(), []);
	assert.deepEqual(ended, ["ingest completed"]);
	assert.equal(duet.listeners.get(path)?.length, 0, "it stops listening");
	assert.equal(changes, 2);
});

test("a turn that ended before the subscription is not listed", async () => {
	const duet = fakeDuet("active");
	const list = new Conversations(() => assert.fail("nothing changed"));
	const { path } = await duet.api.newConversation({ message: "/x", title: "A" });
	list.follow(duet.api, path, "repair");
	assert.deepEqual(list.list(), []);
	assert.equal(duet.listeners.get(path)?.length, 0);
});

test("check drops a conversation that ended unseen, and all of them without Duet", async () => {
	const duet = fakeDuet();
	const list = new Conversations(() => {});
	const a = (await duet.api.newConversation({ message: "/x", title: "A" })).path;
	const b = (await duet.api.newConversation({ message: "/x", title: "B" })).path;
	list.follow(duet.api, a, "ingest");
	list.follow(duet.api, b, "repair");
	duet.status.set(a, "ended");
	list.check(duet.api);
	assert.deepEqual(list.list().map((c) => c.path), [b]);
	list.check(undefined);
	assert.deepEqual(list.list(), []);
});

test("a Duet that throws after it turned off counts as gone", async () => {
	const duet = fakeDuet();
	const list = new Conversations(() => {});
	const { path } = await duet.api.newConversation({ message: "/x", title: "A" });
	list.follow(duet.api, path, "ingest");
	list.check({ ...duet.api, conversationStatus: () => { throw new Error("Duet is off"); } });
	assert.deepEqual(list.list(), []);
});

test("stop ends every subscription", async () => {
	const duet = fakeDuet();
	const list = new Conversations(() => {});
	const { path } = await duet.api.newConversation({ message: "/x", title: "A" });
	list.follow(duet.api, path, "ingest");
	list.stop();
	assert.deepEqual(list.list(), []);
	assert.equal(duet.listeners.get(path)?.length, 0);
});

test("duetApi takes Duet's api only when it is on and gives version 1 or later", () => {
	const api = fakeDuet().api;
	const app = (plugin: unknown) => ({ plugins: { getPlugin: (id: string) => (id === "duet" ? plugin : null) } });
	assert.equal(duetApi(app({ api })), api);
	assert.equal(duetApi(app({ api: { ...api, version: 2 } }))?.version, 2);
	assert.equal(duetApi(app({ api: { ...api, version: 0 } })), undefined);
	assert.equal(duetApi(app({ api: { version: 1 } })), undefined);
	assert.equal(duetApi(app({})), undefined);
	assert.equal(duetApi(app(null)), undefined);
	assert.equal(duetApi({}), undefined);
	assert.equal(duetApi(null), undefined);
});
