// Which upstream response headers the adapter forwards to its caller (CUR-1452).
//
// The adapter is a proxy. On preview, `OPENAI_BASE_URL` points at this route, which forwards to the
// same LiteLLM gateway production talks to directly, so the gateway's provenance headers must reach
// both paths. Rebuilding the response as
//
//     new Response(upstream.body, { headers: { 'content-type': … } })
//
// is a one-header allowlist: it drops `x-litellm-model-api-base` and its siblings, so a turn served
// through the adapter arrives with no way to say which model answered (`measured: false`) while the
// same backend reached directly reports `measured: true`.
//
// A proxy is a bad place to omit this, because nothing else breaks: the body streams fine, every
// answer arrives, and nothing downstream can tell "the lane sent no provenance" from "the lane sent
// provenance and we deleted it". Every reader of `measured: false` in this repo treats it as the
// former.
//
// Only the prefixes listed below are forwarded. Copying `upstream.headers` wholesale would carry the
// upstream's `set-cookie`, `www-authenticate` and hop-by-hop framing headers into a response the app
// treats as its own — a worse defect than the one this fixes, and a harder one to see. Add a prefix
// here only when something downstream actually reads it.
const FORWARDED_PREFIXES = ['x-litellm-', 'x-router-'] as const;

// Exact names forwarded as well. `retry-after` and `retry-after-ms` are what chat's retry policy
// (`$lib/chat/server/endpoints/retryPolicy.ts`) reads on a 429; Large 3 is capped per minute, so the
// Mistral route (CUR-3186) has to carry them or chat backs off blind.
const FORWARDED_NAMES = new Set(['retry-after', 'retry-after-ms']);

/**
 * Response headers for a proxied upstream reply.
 *
 * @remarks
 * Always carries `content-type` (defaulting to JSON, as the previous inline version did, so a
 * gateway that omits it still yields a parseable response). Adds any upstream header whose name
 * begins with a {@link FORWARDED_PREFIXES} entry — the provenance headers `endpointOai` reads to
 * populate `routerMetadata`, which is what the provenance badge, the persisted envelope and every
 * served-model assertion ultimately depend on.
 *
 * Header names are matched lowercased: `Headers` normalises on read, but this function also accepts
 * a plain record in tests, where the caller's casing survives.
 *
 * @param upstream - the upstream response's headers
 * @returns a plain record suitable for a `ResponseInit`
 */
export function passthroughResponseHeaders(
	upstream: Headers | Record<string, string>
): Record<string, string> {
	const entries: [string, string][] =
		upstream instanceof Headers ? [...upstream.entries()] : Object.entries(upstream);

	const out: Record<string, string> = {
		'content-type':
			entries.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? 'application/json'
	};

	for (const [name, value] of entries) {
		const lower = name.toLowerCase();
		if (lower === 'content-type') continue;
		if (FORWARDED_NAMES.has(lower) || FORWARDED_PREFIXES.some((p) => lower.startsWith(p)))
			out[lower] = value;
	}

	return out;
}
