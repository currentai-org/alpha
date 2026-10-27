// One real, throwaway chat turn, run once in global-setup before any spec's own
// assertions start — so a PR preview's cold start is paid for on a step with no 45s ceiling of its
// own, not on whichever spec's turn happens to run first (CUR-1803).
//
// A cheap route ping does NOT do this: pinging
// /folkways-adapter/v1/models and /chat/api/v2/models every 60s against real chat turns showed no
// evidence it helps (mean rose, if anything; CUR-1747) — ~90% of the wait is the upstream first-token call,
// which a route ping that never reaches the model never touches. This has to be a real turn through
// the real generation path, same shape as scripts/synthetic-turn.mjs: create a conversation
// (anonymous, no sign-in needed), send one turn, drain the stream, delete the conversation.

const WARMUP_MS_ENV = 'SCENARIO_WARMUP_MS';
const WARMUP_ERROR_ENV = 'SCENARIO_WARMUP_ERROR';

export interface WarmupResult {
	ok: boolean;
	ms: number;
	error?: string;
}

/**
 * Sends one throwaway turn through the real chat API and waits for it to finish streaming.
 * 60s budget — generous relative to the 45s ceiling this exists to protect, since a cold path's
 * worst observed case is ~44s and this has no downstream assertion timing out under it.
 * Never throws: a warm-up that fails is recorded (via {@link recordWarmup}) and surfaced in the
 * specs' own failure messages. A broken warm-up is itself evidence about coldness worth reading in
 * the failure message; aborting the whole run over it would throw away a suite that could still pass.
 */
export async function warmUpChatPath(baseURL: string): Promise<WarmupResult> {
	const started = Date.now();
	const origin = new URL(baseURL).origin;
	let cookie = '';
	const remember = (res: Response) => {
		const set = res.headers.getSetCookie?.() ?? [];
		const jar = new Map(
			cookie ? cookie.split('; ').map((c) => c.split('=').slice(0, 2) as [string, string]) : []
		);
		for (const c of set) {
			const [k, v] = c.split(';')[0].split('=');
			if (k) jar.set(k, v);
		}
		cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
	};
	const headers = (extra: Record<string, string> = {}) => ({
		origin,
		...(cookie ? { cookie } : {}),
		...extra
	});

	let conversationId: string | undefined;
	try {
		const modelsRes = await fetch(`${baseURL}/chat/api/models`, {
			headers: headers(),
			signal: AbortSignal.timeout(30_000)
		});
		if (!modelsRes.ok) throw new Error(`GET /chat/api/models -> HTTP ${modelsRes.status}`);
		const models = (await modelsRes.json()) as Array<{ id?: string; name?: string }>;
		const model = models?.[0]?.id ?? models?.[0]?.name;
		if (!model) throw new Error('no model advertised by /chat/api/models');

		const created = await fetch(`${baseURL}/chat/conversation`, {
			method: 'POST',
			headers: headers({ 'content-type': 'application/json' }),
			body: JSON.stringify({ model }),
			signal: AbortSignal.timeout(30_000)
		});
		remember(created);
		if (!created.ok) throw new Error(`POST /chat/conversation -> HTTP ${created.status}`);
		const body = (await created.json()) as { conversationId?: string };
		conversationId = body.conversationId;
		if (!conversationId) throw new Error('no conversationId returned');

		const form = new FormData();
		form.set(
			'data',
			JSON.stringify({
				inputs: 'CUR-1803 warm-up: reply with exactly ok',
				id: crypto.randomUUID(),
				is_retry: false
			})
		);
		const turn = await fetch(`${baseURL}/chat/conversation/${conversationId}`, {
			method: 'POST',
			headers: headers(),
			body: form,
			signal: AbortSignal.timeout(60_000)
		});
		if (!turn.ok) throw new Error(`POST turn -> HTTP ${turn.status}`);
		if (!turn.body) throw new Error('turn response had no body');

		// Drain to completion. Content is never read — this exists to pay the cold-start cost, not to
		// verify the answer, which is exactly what the specs that follow already do.
		const reader = turn.body.getReader();
		for (;;) {
			const { done } = await reader.read();
			if (done) break;
		}

		return { ok: true, ms: Date.now() - started };
	} catch (err) {
		return {
			ok: false,
			ms: Date.now() - started,
			error: err instanceof Error ? err.message : String(err)
		};
	} finally {
		if (conversationId) {
			await fetch(`${baseURL}/chat/conversation/${conversationId}`, {
				method: 'DELETE',
				headers: headers()
			}).catch(() => {
				// Best-effort cleanup. A leftover throwaway conversation is harmless noise in the preview DB.
			});
		}
	}
}

/** Called once from global-setup after {@link warmUpChatPath} resolves, so spec processes (which do
 * not share global-setup's own process, but do inherit its env) can read the result back via
 * {@link warmupContext}. */
export function recordWarmup(result: WarmupResult): void {
	process.env[WARMUP_MS_ENV] = String(result.ms);
	if (result.error) process.env[WARMUP_ERROR_ENV] = result.error;
}

/**
 * One line to append to a 45s-ceiling failure message, so a reader can tell "the warm-up already
 * paid the cold-start cost, so this timeout is probably a real stall" from "the warm-up itself was
 * slow or failed, so this preview may still be cold" without re-deriving it from the raw timings.
 */
export function warmupContext(): string {
	const error = process.env[WARMUP_ERROR_ENV];
	if (error) {
		return ` (the pre-suite warm-up turn itself failed: ${error} — treat this timeout as likely still-cold, not necessarily a real stall)`;
	}
	const ms = Number(process.env[WARMUP_MS_ENV]);
	if (!Number.isFinite(ms)) {
		return ' (no warm-up timing recorded — global-setup may not have run)';
	}
	if (ms > 20_000) {
		return ` (the pre-suite warm-up turn itself took ${ms}ms — this preview may still be cold; a slow answer here is not necessarily a real stall)`;
	}
	return ` (the pre-suite warm-up turn took ${ms}ms and finished cleanly — this preview should be warm, so a timeout here is more likely a real stall than a cold start)`;
}
