import { describe, expect, it } from "vitest";

import { crossModelRouterURL, gatewayFallbackOverride, gatewayRetryDelayMs } from "./gatewayFallbackGate";

// What decides whether CUR-1729 works is what goes ON THE WIRE and how long the turn waits before
// giving up, so these assert the body fragment and the millisecond figure rather than a boolean.
// The two that matter are the side-call exclusion and the cap: each one, removed, turns exactly its
// own test red and nothing else.

/** The exact 429 body the production gateway returns, trimmed to what we parse. */
const REAL_429_BODY =
	'{"error":{"message":"No deployments available for selected model, Try again in 5 seconds. ' +
	"Passed model=swiss-ai/apertus-v1.5-70b. pre-call-checks=False, cooldown_list=['0218788']\"}}";

describe("gatewayFallbackOverride — which calls are allowed to make the gateway refuse", () => {
	it("asks the gateway not to substitute on the turn the user reads", () => {
		expect(gatewayFallbackOverride(true)).toEqual({ disable_fallbacks: true });
	});

	it("sends nothing on a side call, so a classifier keeps landing wherever the gateway has room", () => {
		expect(gatewayFallbackOverride(false)).toEqual({});
		expect(gatewayFallbackOverride(undefined)).toEqual({});
	});

	// A host that validates its body strictly answers 422 extra_forbidden on this field (CUR-2280).
	const GATEWAY = "https://gateway.example/v1";
	it("sends nothing to a host that is not the gateway, which would reject the unknown field", () => {
		expect(gatewayFallbackOverride(true, "https://api.mistral.ai/v1", GATEWAY)).toEqual({});
	});

	it("still asks the gateway itself, trailing slash or not", () => {
		expect(gatewayFallbackOverride(true, `${GATEWAY}/`, GATEWAY)).toEqual({ disable_fallbacks: true });
	});

	// An event deployment's primary can be an adapter in front of the gateway while the backup lane calls
	// the gateway directly (CUR-3936).
	const ADAPTER = "https://mozfest.example/folkways-adapter/v1";
	it("asks the gateway not to substitute on the backup lane too, when the primary is a relay in front of it", () => {
		expect(gatewayFallbackOverride(true, GATEWAY, [ADAPTER, GATEWAY])).toEqual({ disable_fallbacks: true });
		expect(gatewayFallbackOverride(true, ADAPTER, [ADAPTER, GATEWAY])).toEqual({ disable_fallbacks: true });
		expect(gatewayFallbackOverride(true, "https://api.mistral.ai/v1", [ADAPTER, GATEWAY])).toEqual({});
	});

	it("ignores an unset backup URL in the list rather than treating every host as the gateway", () => {
		expect(gatewayFallbackOverride(true, "https://api.mistral.ai/v1", [GATEWAY, undefined, ""])).toEqual({});
	});
});

describe("gatewayRetryDelayMs — how long we honour a cooldown before failing honestly", () => {
	it("reads the interval out of the real gateway 429's body prose", () => {
		expect(gatewayRetryDelayMs(null, REAL_429_BODY)).toBe(5_000);
	});

	it("prefers the Retry-After header when the gateway sends a standard one", () => {
		expect(gatewayRetryDelayMs("2", REAL_429_BODY)).toBe(2_000);
	});

	it("caps a cooldown longer than the turn's own budget instead of obeying it", () => {
		// The turn dies at the 45s watchdog and preview's screening phase at 25s, so a 60s wait hands
		// the person the same nothing, later. Capped, the retry still happens and still fails fast.
		expect(gatewayRetryDelayMs("60", undefined)).toBe(6_000);
		expect(gatewayRetryDelayMs(null, "Try again in 45 seconds.")).toBe(6_000);
	});

	it("returns null when nothing named an interval, so an unrecognised 429 fails rather than retrying blind", () => {
		expect(gatewayRetryDelayMs(null, undefined)).toBeNull();
		expect(gatewayRetryDelayMs(null, "Rate limit exceeded.")).toBeNull();
		// An HTTP-date Retry-After is legal and we do not parse it; failing closed beats guessing.
		expect(gatewayRetryDelayMs("Wed, 21 Sep 2026 10:30:00 GMT", undefined)).toBeNull();
	});

	it("accepts a fractional interval, since the cap is the only thing that should shorten a wait", () => {
		expect(gatewayRetryDelayMs(null, "Try again in 0.5 seconds")).toBe(500);
	});
});

describe("crossModelRouterURL — Large 4 is answered by Large 4 or not at all (CUR-4551)", () => {
	const ROUTER = "https://router.stg.aipotluck.org/v1";
	const GATEWAYS = (wire: string) => ["https://gateway.example/v1", undefined, crossModelRouterURL(wire, ROUTER)];

	it("refuses the router's Bedrock Large 3 backup on a Large 4 answer", () => {
		expect(gatewayFallbackOverride(true, ROUTER, GATEWAYS("mistralai/mistral-large-2610"))).toEqual({
			disable_fallbacks: true,
		});
	});

	it("leaves Large 3 its same-model Bedrock backup", () => {
		expect(gatewayFallbackOverride(true, ROUTER, GATEWAYS("mistralai/mistral-large-2512"))).toEqual({});
	});

	it("still sends nothing to La Plateforme for Large 4, which rejects the field", () => {
		expect(
			gatewayFallbackOverride(true, "https://api.mistral.ai/v1", GATEWAYS("mistralai/mistral-large-2610"))
		).toEqual({});
	});
});
