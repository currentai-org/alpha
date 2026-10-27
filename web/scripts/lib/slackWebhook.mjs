// One Slack incoming-webhook post, shared by the server and scripts so timeout and error text stay
// identical (CUR-2654).

/**
 * POSTs `{ text }` to a Slack webhook and throws when Slack refuses it. A Workflow trigger accepts
 * exactly this one variable, so the payload stays `{ text }`: an extra key is an input validation
 * error. fetch resolves on 4xx/5xx, so the status is checked here.
 * @param {string} url
 * @param {string} text
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<void>}
 */
export async function postSlackWebhook(url, text, { timeoutMs = 10_000, fetchImpl = fetch } = {}) {
	const res = await fetchImpl(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) throw new Error(`Slack webhook HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
