import { describe, expect, it, vi } from "vitest";

// The `history_mac_key_rotated` stand-in is only a fair rotation if it keeps every configured
// key for checking and makes a new one active; the scenario spec history-seal-writes-flag.spec.ts drives
// it from a browser. Outside the fault the ring is the configured one.

const H = vi.hoisted(() => ({ cfg: { CONVERSATION_HISTORY_MAC_KEY: "11".repeat(32) } as Record<string, string | undefined> }));
vi.mock("$lib/chat/server/config", () => ({ config: H.cfg }));

import { E2E_ROTATED_MAC_KID, LEGACY_MAC_KID, macRing } from "./sealedTurn";
import { runWithRequestContext, updateRequestContext } from "$lib/chat/server/requestContext";

describe("macRing under history_mac_key_rotated", () => {
	it("keeps the configured key for checking and makes a new, different key active", () => {
		const ring = runWithRequestContext(() => macRing(), { requestId: "r" });
		expect(ring.active).toBe(LEGACY_MAC_KID);
		const rotated = runWithRequestContext(() => {
			// As the conversation route sets it for the fault.
			updateRequestContext({ macKeyRotated: true });
			return macRing();
		});
		expect(rotated.active).toBe(E2E_ROTATED_MAC_KID);
		expect([...rotated.keys.keys()].sort()).toEqual([E2E_ROTATED_MAC_KID, LEGACY_MAC_KID].sort());
		expect(rotated.keys.get(LEGACY_MAC_KID)!.equals(ring.keys.get(LEGACY_MAC_KID)!)).toBe(true);
		expect(rotated.keys.get(E2E_ROTATED_MAC_KID)!.equals(ring.keys.get(LEGACY_MAC_KID)!)).toBe(false);
	});

	it("leaves the ring as configured on a request without the fault", () => {
		const ring = runWithRequestContext(() => macRing());
		expect([...ring.keys.keys()]).toEqual([LEGACY_MAC_KID]);
		expect(ring.active).toBe(LEGACY_MAC_KID);
	});
});

