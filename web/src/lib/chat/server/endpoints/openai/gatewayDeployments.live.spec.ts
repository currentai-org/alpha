import { describe, expect, it } from "vitest";
import { backendForDeployment, resetGatewayDeployments } from "./gatewayDeployments";
import { backendOrg } from "$lib/chat/routing/catalog";
import { backendHost } from "$lib/chat/servingProvenance";

// LIVE CONTRACT CHECK for where an answer says it ran. The gateway names the answering deployment on
// every response (x-litellm-model-id) and its base URL only on some, so the answer's host comes from
// the gateway's deployment list by that id. This sends real unstreamed turns, which are the ones
// that can omit the base URL, and asserts that every one resolves to a host the catalog can name
// with a country. It goes red when the gateway stops sending the id, stops listing it, or starts
// sending a model to a host nobody has vetted, which is when the answer would say "host not recorded".
// When the gateway does send the base URL, the list must agree with it.
//
// Gated on GATEWAY_DEPLOYMENTS_LIVE=1 plus a gateway base URL, a key and a model id the key may call.
// It only reads the gateway: one GET of the deployment list and a few five-token turns.

const LIVE = process.env.GATEWAY_DEPLOYMENTS_LIVE === "1";
const BASE = (process.env.GATEWAY_BASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.GATEWAY_API_KEY || "";
const MODEL = process.env.GATEWAY_MODEL || "";
const ready = LIVE && Boolean(BASE && KEY && MODEL);

describe.skipIf(!ready)("an unstreamed gateway turn resolves to a named host with a country", () => {
	it("names a catalog host for every turn's deployment, and agrees with the base URL whenever the gateway sends one", async () => {
		resetGatewayDeployments();
		const authorization = `Bearer ${KEY}`;
		for (let turn = 1; turn <= 3; turn++) {
			const res = await fetch(`${BASE}/chat/completions`, {
				method: "POST",
				headers: { authorization, "content-type": "application/json" },
				body: JSON.stringify({ model: MODEL, max_tokens: 5, messages: [{ role: "user", content: `Say ok ${turn}` }] }),
			});
			expect(res.status, `turn ${turn} answered ${res.status}`).toBe(200);
			await res.body?.cancel();
			const deployment = res.headers.get("x-litellm-model-id");
			expect(deployment, `turn ${turn} names no deployment`).toBeTruthy();
			const resolved = await backendForDeployment(deployment, { baseURL: BASE, authorization });
			const org = backendOrg(backendHost(resolved));
			expect(org?.country, `turn ${turn}: deployment ${deployment} resolved to ${resolved ?? "nothing"}, no named host with a country`).toBeTruthy();
			const sent = res.headers.get("x-litellm-model-api-base");
			if (sent) expect(backendHost(resolved), `turn ${turn}: the list disagrees with the header`).toBe(backendHost(sent));
		}
	});
});
