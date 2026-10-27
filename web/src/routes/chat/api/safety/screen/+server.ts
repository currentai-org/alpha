// POST /chat/api/safety/screen — the INTERNAL screening endpoint (coop-review-plane Step 4a).
//
// The agent service (agent-service/api/app.py) calls this as the ONE detector, so agent and chat screen
// through the SAME runGuardScreen + rules.json — one policy, one implementation. It is a PURE detector:
// it runs the screen and returns the verdict + fired rules. It NEVER reports to Coop and NEVER touches
// the DB — reporting (the review plane) is owned service-side by the caller (Step 4c). Because it never
// calls the report hook, the "probe/shadow/screen endpoint never report" contract holds structurally.
//
// AUTH: a shared bearer (SAFETY_SCREEN_TOKEN), constant-time compared over fixed-length HMAC digests —
// the CUR-922 pattern (hooks/handle.ts, admin/env-extract). 401 on a wrong/absent bearer; 503 (loud) when
// the token is UNSET — config missing is not an open door. The token is CONFIG, not a feature flag; this
// endpoint is NOT gated by `guard-primary` (that flag governs the chat turn path only — the agent asks
// for screening by configuration, on its own deploy cadence).
//
// HOOK: hooks/handle.ts returns this exact path EARLY, before the model-registry gate, the DB-backed
// config refresh, authenticateRequest (which would POST this bearer to huggingface.co/api/whoami-v2 and
// 401 the agent), and the AUTOMATIC_LOGIN redirect. So this handler owns its whole gate; nothing above it
// reads the DB or redirects. See the early return in handle.ts and screen/+server.spec.ts.
import { json } from "$lib/chat/server/api/utils/json";
import type { RequestHandler } from "@sveltejs/kit";
import { hmacSha256, timingSafeEqual } from "$lib/chat/server/crypto";
import { captureServerException } from "$lib/chat/server/errorTracking";
import { logger } from "$lib/chat/server/logger";
import { runGuardScreen, toHits } from "$lib/chat/server/guardGate";
import { loadGuardPolicy } from "$lib/chat/server/guardPolicy";
import { textOnlyGuardInput, GUARD_CORPUS_CAP } from "$lib/chat/server/guardScreenTypes";
import { safetyScreenToken } from "$lib/chat/server/safetyScreen";

// Hashing both sides to a fixed 64-hex digest before timingSafeEqual is what keeps the compare safe over
// arbitrary-length strings (CUR-922). Label is per-endpoint so a digest from one gate is meaningless at
// another.
const AUTH_HASH_LABEL = "safety-screen-auth-v1";

// The output document is the assistant's OWN answer, not an untrusted user message — so these surfaces
// screen with the shield's OUTPUT instruct (Step 3b). Every other surface (agent-input, agent-check_cmd,
// and any unknown label) uses the default input instruct, which frames the text as untrusted — the safe
// default for a surface we do not recognise.
const OUTPUT_SHAPED_SURFACES = new Set(["agent-output", "agent-artifacts"]);

const errorResponse = (status: number, message: string) =>
	new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "content-type": "application/json" },
	});

export const POST: RequestHandler = async ({ request }) => {
	const token = safetyScreenToken();
	if (!token) {
		// Loud misconfiguration, NOT a silent open door: the agent cannot screen until this is set.
		logger.error(
			"[safety/screen] SAFETY_SCREEN_TOKEN is unset — refusing (503). The agent service cannot screen through this endpoint until it is configured."
		);
		void captureServerException(new Error("SAFETY_SCREEN_TOKEN is unset — safety/screen refusing (503)"));
		return errorResponse(503, "safety screen not configured");
	}

	// Constant-time over equal-length HMAC digests — never a raw string compare against the header.
	const [supplied, expected] = await Promise.all([
		hmacSha256(AUTH_HASH_LABEL, request.headers.get("authorization") ?? ""),
		hmacSha256(AUTH_HASH_LABEL, `Bearer ${token}`),
	]);
	if (!timingSafeEqual(supplied, expected)) {
		return errorResponse(401, "Unauthorized");
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return errorResponse(400, "body must be JSON { text: string, surface: string }");
	}
	const text = (body as { text?: unknown } | null)?.text;
	const surface = (body as { surface?: unknown } | null)?.surface;
	if (typeof text !== "string" || typeof surface !== "string") {
		return errorResponse(400, "body must be { text: string, surface: string }");
	}
	if (text.length > GUARD_CORPUS_CAP) {
		// The caller truncates head+tail BEFORE POST (agent-service _head_tail_truncate); over the cap is a
		// caller bug, not something to silently clip and screen partially.
		return errorResponse(413, `text exceeds the ${GUARD_CORPUS_CAP}-char screen cap`);
	}

	// Output-shaped surfaces screen with the OUTPUT instruct; everything else uses the default input
	// instruct (deps.instruct undefined → runGuardScreen reads shield.instruct).
	const instruct = OUTPUT_SHAPED_SURFACES.has(surface)
		? (loadGuardPolicy()?.shield.outputInstruct ?? undefined)
		: undefined;

	const screen = await runGuardScreen(textOnlyGuardInput(text), { instruct });
	// Union of block ∪ log hits on EVERY status — an UNKNOWN screen can still carry a fired log hit, and a
	// safe screen can carry a log-only detection; the caller decides what to report.
	const hits = toHits([...screen.blockHits, ...screen.logHits]);
	logger.info(`[safety/screen] surface=${surface} status=${screen.status} hits=${hits.length}`);
	return json({ status: screen.status, hits });
};
