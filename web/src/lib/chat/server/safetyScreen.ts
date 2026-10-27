// safetyScreen — config readers for the INTERNAL screening endpoint (POST /chat/api/safety/screen).
// The agent service (agent-service/api/app.py) calls that endpoint as the
// ONE detector; this module is the leaf both the route and the warm probe read, so neither
// duplicates the env name. Call-time reads, so tests can stub.
//
// SAFETY_SCREEN_TOKEN is the shared bearer secret the route checks (constant-time). It is CONFIG, not a
// feature toggle: the route 503s while it is unset (config missing ≠ open door), and the flag that
// governs the CHAT turn path (`guard-primary`) does NOT gate this endpoint — the agent asks for it by
// configuration, on its own deploy cadence.

/** The shared bearer secret for POST /chat/api/safety/screen. Unset → the route refuses with a loud 503. */
export function safetyScreenToken(): string | undefined {
	return process.env.SAFETY_SCREEN_TOKEN?.trim() || undefined;
}

/** True once the screen endpoint is armed (its bearer is set) — the agent service can reach it. Read by
 *  warmGuardHealth (Step 4d): the identity probe must cover the agent-only rollout window, where the chat
 *  flag is OFF but the agent is already screening through this endpoint. */
export function safetyScreenConfigured(): boolean {
	return !!safetyScreenToken();
}
