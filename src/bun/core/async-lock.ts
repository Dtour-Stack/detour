/**
 * Per-key async mutex — serializes async work scoped to a string key.
 *
 * Use when a service holds in-memory state (Map / object graph) that is
 * mutated across `await` points and the same logical key can be touched by
 * concurrent callers (cron job edits, inbox status updates, gateway
 * identity merges, etc.). The classic shape is:
 *
 *   const job = this.jobs.get(id);
 *   await runtime.deleteTask(job.taskId);  // ← another caller can race here
 *   job.taskId = await runtime.createTask(...);
 *   this.persist();
 *
 * Wrap that body in `lock.run(id, async () => { ... })` and the second
 * caller for the same `id` waits until the first completes.
 *
 * Keys are released as soon as the queue empties, so memory is bounded by
 * the number of *in-flight* keys, not the total ever seen.
 */
export class KeyedAsyncLock {
	private readonly tails = new Map<string, Promise<void>>();

	async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		let release: () => void = () => {};
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		const chained = previous.then(() => next);
		this.tails.set(key, chained);
		try {
			await previous;
			return await fn();
		} finally {
			release();
			// Drop the entry only if no one chained after us — otherwise
			// they're our queued successors and we leave the tail in place.
			if (this.tails.get(key) === chained) this.tails.delete(key);
		}
	}

	/** Diagnostic — number of keys with active or queued work. */
	get size(): number {
		return this.tails.size;
	}
}

/**
 * Single-slot async mutex — strictly serializes every call, regardless of
 * key. Mirrors the `enqueueSerializedBuild` pattern in RuntimeService for
 * services where there's only one resource (e.g. cron's `persist()` file).
 */
export class SerialAsyncLock {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(fn: () => Promise<T>): Promise<T> {
		const job = this.tail.then(() => fn());
		this.tail = job.then(
			() => undefined,
			() => undefined,
		);
		return job;
	}
}
