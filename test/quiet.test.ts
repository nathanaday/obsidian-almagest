import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, QuietTimer } from "../src/quiet";

/** A clock the test moves by hand. */
class FakeClock implements Clock {
	now = 0;
	private next = 1;
	private timers = new Map<number, { at: number; fn: () => void }>();

	set(fn: () => void, ms: number): number {
		const id = this.next++;
		this.timers.set(id, { at: this.now + ms, fn });
		return id;
	}

	clear(handle: number): void {
		this.timers.delete(handle);
	}

	get pending(): number {
		return this.timers.size;
	}

	/** Moves the clock and runs each timer that falls due, then lets promises settle. */
	async advance(ms: number): Promise<void> {
		const end = this.now + ms;
		for (;;) {
			const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			this.timers.delete(due[0]);
			this.now = due[1].at;
			due[1].fn();
			await settle();
		}
		this.now = end;
		await settle();
	}
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** A task the test finishes by hand. */
function manualTask() {
	const calls: ((retry: boolean) => void)[] = [];
	return {
		calls,
		task: () => new Promise<boolean>((resolve) => calls.push(resolve)),
	};
}

test("the task runs once the vault has been quiet for the whole period", async () => {
	const clock = new FakeClock();
	let runs = 0;
	const timer = new QuietTimer(clock, async () => (runs++, false), 1000);
	timer.touch();
	await clock.advance(600);
	timer.touch();
	await clock.advance(600);
	assert.equal(runs, 0, "each event starts the period again");
	await clock.advance(400);
	assert.equal(runs, 1);
	await clock.advance(5000);
	assert.equal(runs, 1, "no event, no second run");
});

test("a quiet period of 0 is off", async () => {
	const clock = new FakeClock();
	let runs = 0;
	const timer = new QuietTimer(clock, async () => (runs++, false), 0);
	timer.touch();
	await clock.advance(10_000);
	assert.equal(runs, 0);
	assert.equal(clock.pending, 0);
});

test("a held lock tries again after the next quiet period, with no new event", async () => {
	const clock = new FakeClock();
	const results = [true, true, false];
	let runs = 0;
	const timer = new QuietTimer(clock, async () => results[runs++], 1000);
	timer.touch();
	await clock.advance(1000);
	assert.equal(runs, 1);
	await clock.advance(1000);
	assert.equal(runs, 2);
	await clock.advance(1000);
	assert.equal(runs, 3);
	await clock.advance(5000);
	assert.equal(runs, 3, "a run that succeeds stops the retries");
	assert.ok(!timer.waiting);
});

test("a failure that is not the lock waits for the next event", async () => {
	const clock = new FakeClock();
	let runs = 0;
	const timer = new QuietTimer(clock, async () => {
		runs++;
		throw new Error("boom");
	}, 1000);
	timer.touch();
	await clock.advance(1000);
	await clock.advance(5000);
	assert.equal(runs, 1);
	timer.touch();
	await clock.advance(1000);
	assert.equal(runs, 2);
});

test("never two runs at once: a period that ends during a run waits for it", async () => {
	const clock = new FakeClock();
	const { calls, task } = manualTask();
	const timer = new QuietTimer(clock, task, 1000);
	timer.touch();
	await clock.advance(1000);
	assert.equal(calls.length, 1);
	assert.ok(timer.busy);

	// Events during the run, and their quiet period ends before the run does.
	timer.touch();
	await clock.advance(1000);
	assert.equal(calls.length, 1, "the second run waits");

	calls[0](false);
	await settle();
	assert.ok(!timer.busy);
	assert.ok(timer.waiting, "the edits made during the run get a quiet period of their own");
	await clock.advance(1000);
	assert.equal(calls.length, 2);
	calls[1](false);
	await settle();
	await clock.advance(5000);
	assert.equal(calls.length, 2);
});

test("an event during a run whose period is still open runs once, after it", async () => {
	const clock = new FakeClock();
	const { calls, task } = manualTask();
	const timer = new QuietTimer(clock, task, 1000);
	timer.touch();
	await clock.advance(1000);
	timer.touch();
	await clock.advance(200);
	calls[0](false);
	await settle();
	await clock.advance(799);
	assert.equal(calls.length, 1);
	await clock.advance(1);
	assert.equal(calls.length, 2);
});

test("setQuiet restarts a waiting timer with the new period, and 0 or stop cancels it", async () => {
	const clock = new FakeClock();
	let runs = 0;
	const timer = new QuietTimer(clock, async () => (runs++, false), 1000);
	timer.touch();
	await clock.advance(500);
	timer.setQuiet(3000);
	await clock.advance(2999);
	assert.equal(runs, 0);
	await clock.advance(1);
	assert.equal(runs, 1);

	timer.touch();
	timer.setQuiet(0);
	await clock.advance(10_000);
	assert.equal(runs, 1);
	timer.touch();
	await clock.advance(10_000);
	assert.equal(runs, 1, "0 ignores events");

	timer.setQuiet(1000);
	timer.touch();
	timer.stop();
	await clock.advance(10_000);
	assert.equal(runs, 1);
	assert.equal(clock.pending, 0);
});

test("a held lock after stop does not arm again", async () => {
	const clock = new FakeClock();
	const { calls, task } = manualTask();
	const timer = new QuietTimer(clock, task, 1000);
	timer.touch();
	await clock.advance(1000);
	timer.stop();
	calls[0](true);
	await settle();
	assert.equal(clock.pending, 0);
});
