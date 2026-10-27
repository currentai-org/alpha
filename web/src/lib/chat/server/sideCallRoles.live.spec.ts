import { describe, it, expect, vi } from "vitest";
import type { Endpoint, EndpointMessage } from "./endpoints/types";

// LIVE: a side call to Apertus, shaped by generateFromDefaultEndpoint, is answered by Apertus (CUR-1294).
//
// The answer lane flattens roles for Apertus; side calls (entity scope, world model, query rewrite…) must
// too, because a system role sent to a pooled model group can be answered by a different model in the pool.
// Only a deployment whose TASK_MODEL is Apertus exercises this, so a scenario spec on a deployment
// with another task model cannot see it. This spec makes real calls instead.
//
// What is real: generateFromDefaultEndpoint's shaping, the inference host, and the model that answers
// (the response body's `model`, which names the substitute even when headers do not). What is stubbed:
// the registry, so taskModel is Apertus, and endpointOai's request building, replaced by the plain
// mapping it does (preprompt as the system message, then each turn's role) so the body can be read.
//
// Each arm makes RUNS calls. The first sends what the code shapes and must come back Apertus every
// time. The second turns the flattening off and must see at least one substitute: that is the positive control, and without it a
// clean "as shaped" arm says nothing, because the gateway may simply not have substituted today.
//
// Only an inference host that serves `swiss-ai/apertus-v1.5-70b` reaches the bug; others answer 400.
// So it runs against a gateway that real visitors share, and a run of 2 × 20 calls needs the
// maintainers' OK first, with that gateway's inference credentials in the environment:
//   SIDE_CALL_ROLES_LIVE=1 pnpm test:live src/lib/chat/server/sideCallRoles.live.spec.ts

const env = (k: string) => (process.env[k] ?? "").trim();
const LIVE = env("SIDE_CALL_ROLES_LIVE") === "1" && !!(env("OPENAI_BASE_URL") && env("OPENAI_API_KEY"));
const RUNS = Number(env("SIDE_CALL_ROLES_RUNS") || 20);
const APERTUS = "swiss-ai/apertus-v1.5-70b";

const state = vi.hoisted(() => ({ flatten: true, served: [] as string[], shapes: [] as string[], failed: [] as string[] }));

vi.mock("./modelProfiles", async (orig) => {
	const real = await orig<typeof import("./modelProfiles")>();
	return { ...real, rolesNeedFlattening: (id: string) => state.flatten && real.rolesNeedFlattening(id) };
});

vi.mock("$lib/chat/server/models", () => {
	const endpoint: Endpoint = async ({ messages, preprompt, abortSignal }) => {
		const wire = [
			...(preprompt ? [{ role: "system", content: preprompt }] : []),
			...messages.map((m: EndpointMessage) => ({ role: m.from, content: m.content })),
		];
		state.shapes.push(wire.map((m) => m.role).join(","));
		const res = await fetch(`${env("OPENAI_BASE_URL").replace(/\/+$/, "")}/chat/completions`, {
			method: "POST",
			// Vercel's firewall in front of the preview host refuses a bare Node fetch; warm.ts sends the same UA.
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${env("OPENAI_API_KEY")}`,
				"User-Agent": "aipotluck.org",
				...(env("HF_BILL_TO") ? { "X-HF-Bill-To": env("HF_BILL_TO") } : {}),
			},
			body: JSON.stringify({ model: APERTUS, messages: wire, max_tokens: 8, stream: false }),
			signal: abortSignal,
		});
		// A refused call is an instrument failure, kept apart from the served models: counted as a
		// substitute it would pass the positive control through a 403 and measure nothing.
		if (!res.ok) {
			state.failed.push(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
			throw new Error(`inference host answered ${res.status}`);
		}
		const body = (await res.json()) as { model?: string; choices?: { message?: { content?: string } }[] };
		state.served.push(body.model ?? "(no model)");
		const text = body.choices?.[0]?.message?.content || "-";
		return (async function* () {
			yield { token: { id: 0, text, logprob: 0, special: false }, generated_text: text, details: null };
		})();
	};
	const taskModel = { id: APERTUS, name: APERTUS, parameters: {}, getEndpoint: async () => endpoint };
	return { taskModel, models: [taskModel] };
});

const { generateFromDefaultEndpoint } = await import("./generateFromDefaultEndpoint");

async function arm(flatten: boolean) {
	state.flatten = flatten;
	state.served = [];
	state.shapes = [];
	state.failed = [];
	for (let i = 0; i < RUNS; i++) {
		const gen = generateFromDefaultEndpoint({
			preprompt: "You decide whether a question needs a web search. Reply with one word: yes or no.",
			messages: [{ from: "user", content: `Question ${i}: what is the population of Lagos today?` }],
			timeoutMs: 60_000,
			locals: undefined,
		});
		while (!(await gen.next()).done);
		await new Promise((r) => setTimeout(r, 500));
	}
	const substitutes = state.served.filter((m) => !m.toLowerCase().includes("apertus"));
	console.log(`[side-call roles] flatten=${flatten} shapes=${[...new Set(state.shapes)]} served=${JSON.stringify(state.served)} failed=${JSON.stringify(state.failed)}`);
	expect(state.failed, "the inference host refused calls, so this arm measured nothing").toEqual([]);
	expect(state.served).toHaveLength(RUNS);
	return substitutes;
}

describe.skipIf(!LIVE)("side calls to Apertus (live)", () => {
	it("keeps no system role on the wire and is answered by Apertus every time", async () => {
		const substitutes = await arm(true);
		expect(new Set(state.shapes), "the side call went out with a role other than user").toEqual(new Set(["user"]));
		expect(substitutes, "a flattened side call was answered by another model").toEqual([]);
	}, 600_000);

	it("positive control: the same call with its system role kept is substituted at least once", async () => {
		const substitutes = await arm(false);
		expect(new Set(state.shapes)).toEqual(new Set(["system,user"]));
		expect(
			substitutes.length,
			"no substitution with roles kept, so the clean arm above proves nothing today; rerun or raise SIDE_CALL_ROLES_RUNS"
		).toBeGreaterThan(0);
	}, 600_000);
});
