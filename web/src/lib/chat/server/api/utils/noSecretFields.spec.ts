import { describe, expect, it } from "vitest";
import { json } from "./json";
import { superjsonResponse } from "./superjsonResponse";
import { discloseToOwner } from "./noSecretFields";

// The assertions that matter here are the `@ts-expect-error` lines: `pnpm check` fails when one of
// them stops being an error, which is how a weakened guard shows up (CUR-2643).
type RegistryEntry = { id: string; endpoints: { baseURL: string; apiKey?: string }[] };
const entry: RegistryEntry = { id: "m", endpoints: [{ baseURL: "https://example.org", apiKey: "k" }] };

describe("NoSecretFields: a response may not carry a secret-named field", () => {
	it("refuses the model registry entry's nested endpoints[].apiKey, the CUR-2643 leak", () => {
		// @ts-expect-error apiKey under endpoints[]
		expect(() => superjsonResponse(entry)).not.toThrow();
		// @ts-expect-error apiKey under endpoints[]
		expect(() => json(entry)).not.toThrow();
	});

	it("refuses suffixed names (clientSecret, tunnelSecret, adminPassword)", () => {
		// @ts-expect-error clientSecret
		json({ clientSecret: "s" });
		// @ts-expect-error tunnelSecret
		json({ install: { tunnelSecret: "s" } });
		// @ts-expect-error adminPassword
		json([{ adminPassword: "p" }]);
	});

	it("lets a secret through only when it is marked as disclosed to its owner", () => {
		const res = json({ installArgs: { tunnelSecret: discloseToOwner("s") } });
		expect(res.status).toBe(200);
	});

	it("passes ordinary payloads, including a streamed LLM `token`", () => {
		expect(json({ id: "m", messages: [{ type: "stream", token: "hi" }] }).status).toBe(200);
		expect(superjsonResponse({ available: true }).status).toBe(200);
	});

	it("passes a field typed `any`, which says nothing about what it holds", () => {
		const base = JSON.parse("null") as any; // eslint-disable-line @typescript-eslint/no-explicit-any
		expect(json({ base, error: "unreachable" }).status).toBe(200);
	});
});
