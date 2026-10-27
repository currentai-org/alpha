/**
 * The per-request serialized conversation-write chain. Two enqueued
 * writes must never interleave (docStore.updateOne is a whole-document read-modify-write — concurrent
 * writes lose updates); a failing LATER link must not wedge the chain; and the per-link promise must
 * carry its rejection to the awaiter (the user-msg persist errors the turn) WITHOUT floating when the
 * awaiter is skipped (the settings-first-failure case).
 */
import { describe, expect, it } from "vitest";
import { createConversationWriteChain } from "./conversationWriteChain";

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// Drain the microtask + timer queues so gated links have a chance to (not) start.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createConversationWriteChain", () => {
	it("runs enqueued writes strictly in order, never interleaved", async () => {
		const chain = createConversationWriteChain();
		const events: string[] = [];
		const a = deferred<void>();
		const b = deferred<void>();

		const pa = chain.enqueue(async () => {
			events.push("a:start");
			await a.promise;
			events.push("a:end");
		});
		const pb = chain.enqueue(async () => {
			events.push("b:start");
			await b.promise;
			events.push("b:end");
		});

		// The second write is gated on the first settling: only "a" has started, "b" has not.
		await flush();
		expect(events).toEqual(["a:start"]);

		a.resolve();
		await pa;
		await flush();
		expect(events).toEqual(["a:start", "a:end", "b:start"]);

		b.resolve();
		await pb;
		expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
	});

	it("a failing LATER link does not wedge the chain (order preserved past the failure)", async () => {
		const chain = createConversationWriteChain();
		const events: string[] = [];
		const p1 = chain.enqueue(async () => {
			events.push("1");
		});
		const p2 = chain.enqueue(async () => {
			events.push("2");
			throw new Error("boom");
		});
		const p3 = chain.enqueue(async () => {
			events.push("3");
		});

		await expect(p1).resolves.toBeUndefined();
		await expect(p2).rejects.toThrow("boom");
		await expect(p3).resolves.toBeUndefined();
		expect(events).toEqual(["1", "2", "3"]);
	});

	it("the (user-msg) link's rejection is observable to its awaiter", async () => {
		const chain = createConversationWriteChain();
		const err = new Error("persist failed");
		const p = chain.enqueue(async () => {
			throw err;
		});
		await expect(p).rejects.toBe(err);
	});

	it("a rejecting link whose returned promise is never awaited does not float (invariant 7)", async () => {
		// The tail-advance registers a rejection handler on the SAME returned promise, so a link whose
		// join is skipped (its awaiter's earlier join threw) is not an unhandled rejection. Enqueue a
		// rejecting write and NEVER await it; a later link still runs, and no unhandled rejection fires.
		const chain = createConversationWriteChain();
		const events: string[] = [];
		let unhandled: unknown;
		const onUnhandled = (e: PromiseRejectionEvent | unknown) => {
			unhandled = e;
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			void chain.enqueue(async () => {
				throw new Error("orphan"); // deliberately not awaited
			});
			const p2 = chain.enqueue(async () => {
				events.push("after");
			});
			await p2;
			await flush();
			expect(events).toEqual(["after"]);
			expect(unhandled).toBeUndefined();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
