// Adapted from huggingface/chat-ui's src/lib/server/abortedGenerations.ts. Shouldn't be needed if we dove into
// sveltekit internals, see https://github.com/huggingface/chat-ui/pull/88#issuecomment-1523173850

import { logger } from "$lib/chat/server/logger";
import { collections } from "$lib/chat/server/database";
import { onExit } from "./exitHandler";

/**
 * Cross-instance abort signaling. A Stop click can land on a different serverless instance than the one
 * streaming the generation, so the streaming instance polls the `aborted_generations` table to notice it.
 *
 * The poll is DEMAND-GATED: it runs only while this instance has at least one active generation
 * (beginGeneration/endGeneration bracket each `generate()` run). An idle instance does ZERO polling —
 * a free-running 1s setInterval would query the database forever, and on a frozen/idle serverless instance
 * that query hits a reaped pooler socket (CONNECTION_CLOSED) or an autosuspended compute (CONNECT_TIMEOUT),
 * filling the error log and churning connections. With no active generation there's also no consumer of
 * getAbortTime(), so skipping the poll loses nothing.
 */
export class AbortedGenerations {
	private static instance: AbortedGenerations;

	private abortedGenerations: Record<string, Date> = {};
	private interval: ReturnType<typeof setInterval> | null = null;
	private activeCount = 0;

	private constructor() {
		// No eager work at init (getInstance runs at server boot): polling starts on the first generation.
		onExit(() => this.stopPolling());
	}

	public static getInstance(): AbortedGenerations {
		if (!AbortedGenerations.instance) {
			AbortedGenerations.instance = new AbortedGenerations();
		}

		return AbortedGenerations.instance;
	}

	/** A generation became active on this instance; start the cross-instance poll if not already running. */
	public beginGeneration(): void {
		this.activeCount += 1;
		if (!this.interval) {
			// Poll once immediately so the first abort check isn't blind for up to a second after an idle
			// gap, then every second while any generation is active.
			void this.updateList();
			this.interval = setInterval(() => void this.updateList(), 1000);
		}
	}

	/** A generation finished; once none remain active on this instance, stop polling so it can go idle. */
	public endGeneration(): void {
		this.activeCount = Math.max(0, this.activeCount - 1);
		if (this.activeCount === 0) this.stopPolling();
	}

	private stopPolling(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	public getAbortTime(conversationId: string): Date | undefined {
		return this.abortedGenerations[conversationId];
	}

	/** Test-only: stop polling and clear state so each test starts from idle. */
	public _resetForTest(): void {
		this.stopPolling();
		this.activeCount = 0;
		this.abortedGenerations = {};
	}

	private async updateList() {
		try {
			const aborts = await collections.abortedGenerations.find({}).sort({ createdAt: 1 }).toArray();

			this.abortedGenerations = Object.fromEntries(
				aborts.map((abort) => [abort.conversationId.toString(), abort.updatedAt ?? abort.createdAt])
			);
		} catch (err) {
			// A best-effort poll that self-heals on the next tick. Connection-class blips
			// (CONNECTION_CLOSED / CONNECT_TIMEOUT to the Neon pooler) are expected on serverless cold/idle
			// edges, so this is warn, not error — it should not read as an actionable failure or drown real
			// DB errors. The safe default holds meanwhile: getAbortTime() returns undefined ("not aborted").
			logger.warn({ err }, "aborted-generations poll failed (will retry next tick)");
		}
	}
}
