// One Shieldstral judge call as the app sends it (detectors/shieldstral.ts): the model card's system
// prompt, the <Instruct>/<Query>/<Document> user message, one token with top_logprobs, scored by the
// app's own strict ladder. shield-calibration.mjs and guard-first-pass-parity.mjs both judge through it.
import {
	SHIELD_SYSTEM_PROMPT,
	buildShieldUserText,
	parseShieldAnswerCore,
} from "../../src/lib/chat/server/guardPolicyCore.mjs";

const MODEL = "mistralai/Shieldstral-1.0-3B";

/**
 * @param {{ base: string, token?: string, billTo?: string, instruct: string, windowChars?: number, timeoutMs?: number }} opts
 */
export function makeShieldJudge({ base, token, billTo, instruct, windowChars = 12000, timeoutMs = 60000 }) {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	async function fetchWithRetry(url, opts, retries = 2) {
		for (let attempt = 0; ; attempt++) {
			let res;
			try {
				res = await fetch(url, opts);
			} catch (e) {
				if (attempt < retries) {
					process.stderr.write(`  fetch error (${e?.name || e}) — retry ${attempt + 1}/${retries} in 10s...\n`);
					await sleep(10000);
					continue;
				}
				throw e;
			}
			// The guard endpoint is configured never to scale to zero, so a 503 is a transient endpoint
			// fault (replica restart / overload), not a cold-start; retry a few times regardless.
			if (res.status === 503 && attempt < retries) {
				process.stderr.write(`  endpoint 503 (transient fault) — retry ${attempt + 1}/${retries} in 20s...\n`);
				await sleep(20000);
				continue;
			}
			return res;
		}
	}

	/**
	 * One judge call. Returns the parsed ShieldAnswer plus transport metadata.
	 * @returns {Promise<{score: number|null, yes: boolean|null, source: string, http: number, ms: number, served: string}>}
	 */
	async function judge(query, document, threshold) {
		const userText = buildShieldUserText(instruct, query, document, windowChars);
		const body = {
			model: MODEL,
			messages: [
				{ role: "system", content: SHIELD_SYSTEM_PROMPT },
				{ role: "user", content: userText },
			],
			max_tokens: 1,
			temperature: 0,
			logprobs: true,
			top_logprobs: 20,
			stream: false,
		};
		const started = Date.now();
		const res = await fetchWithRetry(`${base}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				...(billTo ? { "X-HF-Bill-To": billTo } : {}),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const ms = Date.now() - started;
		let content;
		let topLogprobs;
		let served = "";
		try {
			const data = await res.json();
			const choice = data?.choices?.[0];
			content = choice?.message?.content;
			topLogprobs = choice?.logprobs?.content?.[0]?.top_logprobs;
			served = String(data?.model ?? "");
		} catch {
			/* leave undefined — parser maps to unknown */
		}
		const parsed = parseShieldAnswerCore({ content, topLogprobs }, threshold);
		const httpOk = res.status >= 200 && res.status < 300;
		if (!httpOk) return { score: null, yes: null, source: `http:${res.status}`, http: res.status, ms, served };
		if (parsed.kind === "score")
			return { score: parsed.score, yes: parsed.yes, source: "logprob", http: res.status, ms, served };
		if (parsed.kind === "token") return { score: null, yes: parsed.yes, source: "token", http: res.status, ms, served };
		return { score: null, yes: null, source: "unknown", http: res.status, ms, served };
	}

	return judge;
}
