// Runs a task after a quiet period with no event. Pure: the clock comes in, so the tests
// drive it.

export interface Clock {
	set(fn: () => void, ms: number): number;
	clear(handle: number): void;
}

/**
 * Each touch starts the quiet period again; when it ends, the task runs. One task runs at
 * a time. A task that resolves true (it could not run, such as when the lock is held)
 * runs again after the next quiet period, with or without a new event. A quiet period of
 * 0 turns the timer off.
 */
export class QuietTimer {
	private handle: number | null = null;
	private running = false;
	/** The quiet period ended while the task ran. */
	private again = false;

	constructor(
		private clock: Clock,
		private task: () => Promise<boolean>,
		private quietMs: number,
	) {}

	/** Starts the quiet period again. */
	touch(): void {
		if (this.quietMs <= 0) return;
		this.arm();
	}

	/** Sets the quiet period; a waiting timer starts again with it. */
	setQuiet(ms: number): void {
		this.quietMs = ms;
		if (ms <= 0) {
			this.cancel();
			this.again = false;
		} else if (this.handle !== null) {
			this.arm();
		}
	}

	/** Stops the timer; a task that runs ends as it would. */
	stop(): void {
		this.quietMs = 0;
		this.again = false;
		this.cancel();
	}

	get waiting(): boolean {
		return this.handle !== null;
	}

	get busy(): boolean {
		return this.running;
	}

	private arm(): void {
		this.cancel();
		this.handle = this.clock.set(() => {
			this.handle = null;
			void this.fire();
		}, this.quietMs);
	}

	private cancel(): void {
		if (this.handle !== null) this.clock.clear(this.handle);
		this.handle = null;
	}

	private async fire(): Promise<void> {
		if (this.running) {
			this.again = true;
			return;
		}
		this.running = true;
		this.again = false;
		let retry = false;
		try {
			retry = await this.task();
		} catch {
			retry = false;
		} finally {
			this.running = false;
		}
		if ((retry || this.again) && this.quietMs > 0 && this.handle === null) this.arm();
		this.again = false;
	}
}
