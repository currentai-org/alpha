// The model a response BODY says wrote it, read without consuming the body the SDK still needs.
//
// The gateway's `x-litellm-model-group` header reports the deployment group LiteLLM routed to, and
// that is not the same fact as the model that answered. A deployment inside the Apertus group
// (`x-litellm-model-name: openai/swiss-ai/Apertus-v1.5-70B`, attempted-fallbacks 0) can answer with
// every chunk naming `aisingapore/Qwen-SEA-LION-v4-32B-IT` while every header names Apertus. The body
// is the only place that swap shows.

/** Stop looking after this many bytes. The model id arrives on the first chunk; a body that has not
 *  named one by here is not going to, and the peek must never buffer a whole answer. */
const PEEK_LIMIT_BYTES = 64 * 1024;

/** Two model ids name the same model. Case differs between a provider's own id and the gateway's
 *  alias (`swiss-ai/Apertus-v1.5-70B` against `swiss-ai/apertus-v1.5-70b`), and LiteLLM's
 *  `openai/` routing prefix names the transport. */
export function sameModelId(a: string, b: string): boolean {
	const norm = (id: string) => id.trim().toLowerCase().replace(/^openai\//, "");
	return norm(a) === norm(b);
}

/** What a body says about who wrote it: the model, and the `provider` OpenRouter adds to every chunk. */
type BodyReport = { model: string | undefined; provider: string | undefined };

const NONE: BodyReport = { model: undefined, provider: undefined };

function reportOf(json: string): BodyReport {
	const parsed = JSON.parse(json) as { model?: unknown; provider?: unknown };
	const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
	return { model: text(parsed.model), provider: text(parsed.provider) };
}

function reportFromSse(text: string): BodyReport {
	for (const line of text.split("\n")) {
		const data = line.startsWith("data:") ? line.slice(5).trim() : "";
		if (!data || data === "[DONE]") continue;
		try {
			const report = reportOf(data);
			if (report.model) return report;
		} catch {
			// A data line split across reads; the next read completes it.
		}
	}
	return NONE;
}

/**
 * Read the served model, and the provider when the body names one, from `response`'s body and hand
 * back an equivalent, unread Response.
 *
 * A streamed body is read only up to the first chunk that names a model, then replayed in front of
 * the rest of the stream, so nothing is lost and nothing waits on the whole answer. A JSON body is read
 * whole, since the SDK would read it whole anyway. Anything else, or a non-2xx, passes through untouched.
 */
export async function peekServedModel(
	response: Response
): Promise<BodyReport & { response: Response }> {
	if (!response.ok || !response.body) return { ...NONE, response };
	const type = response.headers.get("content-type") ?? "";
	const init = { status: response.status, statusText: response.statusText, headers: response.headers };

	if (type.includes("application/json")) {
		const text = await response.text();
		let report = NONE;
		try {
			report = reportOf(text);
		} catch {
			report = NONE;
		}
		return { ...report, response: new Response(text, init) };
	}

	if (!type.includes("text/event-stream")) return { ...NONE, response };

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const buffered: Uint8Array[] = [];
	let seen = "";
	let bytes = 0;
	let report = NONE;
	let done = false;
	while (!report.model && bytes < PEEK_LIMIT_BYTES) {
		const read = await reader.read();
		if (read.done) {
			done = true;
			break;
		}
		buffered.push(read.value);
		bytes += read.value.byteLength;
		seen += decoder.decode(read.value, { stream: true });
		report = reportFromSse(seen);
	}

	const replay = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of buffered) controller.enqueue(chunk);
			if (done) controller.close();
		},
		async pull(controller) {
			const read = await reader.read();
			if (read.done) controller.close();
			else controller.enqueue(read.value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return { ...report, response: new Response(replay, init) };
}

/**
 * The `wrong_model_served` fault (CUR-1614): hand back `response` with every `model` field in its body
 * replaced by `model`, headers untouched.
 *
 * @remarks
 * That is the shape above, where every header named the requested model and every chunk
 * named another, so the substitution checks downstream run on exactly what a real swap sends. SSE is
 * rewritten line by line as it streams; a JSON body is rewritten whole. A non-2xx, or any other body,
 * passes through untouched.
 */
export async function withServedModel(response: Response, model: string): Promise<Response> {
	if (!response.ok || !response.body) return response;
	const type = response.headers.get("content-type") ?? "";
	const init = { status: response.status, statusText: response.statusText, headers: response.headers };
	const rename = (json: string) => {
		try {
			const parsed = JSON.parse(json) as Record<string, unknown>;
			if (!parsed || typeof parsed !== "object" || !("model" in parsed)) return json;
			return JSON.stringify({ ...parsed, model });
		} catch {
			return json;
		}
	};

	if (type.includes("application/json")) {
		return new Response(rename(await response.text()), init);
	}
	if (!type.includes("text/event-stream")) return response;

	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	let pending = "";
	const renameLine = (line: string) =>
		line.startsWith("data:") && line.slice(5).trim() !== "[DONE]"
			? `data: ${rename(line.slice(5).trim())}`
			: line;
	const rewrite = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			pending += decoder.decode(chunk, { stream: true });
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			if (lines.length) controller.enqueue(encoder.encode(lines.map(renameLine).join("\n") + "\n"));
		},
		flush(controller) {
			pending += decoder.decode();
			if (pending) controller.enqueue(encoder.encode(renameLine(pending)));
		},
	});
	return new Response(response.body.pipeThrough(rewrite), init);
}
