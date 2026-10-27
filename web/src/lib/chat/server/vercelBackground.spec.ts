import { describe, it, expect, afterEach, vi } from "vitest";
import { runInBackground, nodeRequestContext } from "./vercelBackground";

const REQ_CTX = Symbol.for("@vercel/request-context");

/** Install a fake Vercel Node request context (the globalThis symbol the runtime bridge populates). */
function installNodeContext(ctx: { waitUntil?: (p: Promise<unknown>) => void }) {
	(globalThis as Record<symbol, unknown>)[REQ_CTX] = { get: () => ctx };
}

/** A promise with externally-driven resolution, to observe scheduling vs awaiting. */
function deferred() {
	let resolve!: () => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

afterEach(() => {
	delete (globalThis as Record<symbol, unknown>)[REQ_CTX];
	vi.unstubAllEnvs();
});

describe("nodeRequestContext — Node request-context symbol read", () => {
	it("returns {} when the runtime bridge has not populated the symbol (dev/tests)", () => {
		expect(nodeRequestContext()).toEqual({});
	});

	it("returns the live context when present", () => {
		const waitUntil = vi.fn();
		installNodeContext({ waitUntil });
		expect(nodeRequestContext().waitUntil).toBe(waitUntil);
	});
});

describe("runInBackground — the warm work must survive the response on Vercel", () => {
	it("prefers the caller's edge platform.context and returns before the work settles", async () => {
		const waitUntil = vi.fn();
		const d = deferred();
		await runInBackground(d.promise, { waitUntil }); // resolves while d is still pending ⇒ scheduled
		expect(waitUntil).toHaveBeenCalledTimes(1);
		d.resolve();
	});

	it("falls back to the NODE request context's waitUntil (the runtime this app deploys on)", async () => {
		const waitUntil = vi.fn();
		installNodeContext({ waitUntil });
		const d = deferred();
		await runInBackground(d.promise);
		expect(waitUntil).toHaveBeenCalledTimes(1);
		d.resolve();
	});

	it("invokes the Node context's waitUntil as a METHOD (a this-dependent context must not throw)", async () => {
		const calls: Array<Promise<unknown>> = [];
		class Ctx {
			#alive = true;
			waitUntil(p: Promise<unknown>) {
				if (!this.#alive) throw new Error("unreachable");
				calls.push(p);
			}
		}
		installNodeContext(new Ctx());
		await runInBackground(Promise.resolve());
		expect(calls).toHaveLength(1);
	});

	it("on Vercel with NO waitUntil, AWAITS the work inline (never leaves it to be frozen)", async () => {
		vi.stubEnv("VERCEL", "1");
		const d = deferred();
		let settled = false;
		const run = runInBackground(d.promise).then(() => {
			settled = true;
		});
		await Promise.resolve(); // give it a microtask: must still be waiting on the work
		expect(settled).toBe(false);
		d.resolve();
		await run;
		expect(settled).toBe(true);
	});

	it("off Vercel with no context, returns immediately (long-lived process; floating is safe)", async () => {
		const d = deferred();
		await runInBackground(d.promise); // resolves while d is still pending
		d.resolve();
	});

	it("swallows a rejecting work promise in every mode (background work is best-effort)", async () => {
		vi.stubEnv("VERCEL", "1");
		await expect(runInBackground(Promise.reject(new Error("leg failed")))).resolves.toBeUndefined();

		vi.unstubAllEnvs();
		const scheduled: Array<Promise<unknown>> = [];
		installNodeContext({ waitUntil: (p) => scheduled.push(p) });
		await runInBackground(Promise.reject(new Error("leg failed")));
		// the SCHEDULED promise is the caught one — waitUntil must never receive a rejecting promise
		await expect(scheduled[0]).resolves.toBeUndefined();
	});
});
