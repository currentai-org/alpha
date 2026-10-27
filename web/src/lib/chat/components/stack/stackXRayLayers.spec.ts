import { describe, it, expect } from "vitest";
import { PROVENANCE_PRODUCTS } from "./provenanceProducts.generated";
import { deriveStackXRayLayers } from "./stackXRayLayers";
import type { Message } from "$lib/chat/types/Message";

const base = (over: Partial<Message> = {}): Message =>
	({ id: "m1", from: "assistant", content: "an answer", ...over }) as Message;

const layer = (m: Message | undefined, name: string) => {
	const l = deriveStackXRayLayers(m).find((row) => row.name === name);
	if (!l) throw new Error(`expected stack x-ray layer "${name}" to be present`);
	return l;
};

describe("deriveStackXRayLayers", () => {
	it("renders one row per provenance product, all untouched pre-turn", () => {
		const layers = deriveStackXRayLayers(undefined);
		expect(layers).toHaveLength(PROVENANCE_PRODUCTS.length);
		expect(layers.every((l) => l.touched === false)).toBe(true);
		expect(layers.map((l) => l.name)).toEqual(PROVENANCE_PRODUCTS.map((p) => p.name));
	});

	it("our own product's link is a path on the serving origin, not production's absolute URL", () => {
		// The roadmap writes it as https://aipotluck.org/chat; on a preview that would leave for prod.
		expect(layer(undefined, "stack-provenance").osProductUrl).toBe("/chat");
		// A third party's URL is left exactly as written.
		expect(layer(undefined, "foundation-model").osProductUrl ?? "").not.toMatch(/^\//);
	});

	it("uses slug-style labels (no humanization)", () => {
		expect(layer(undefined, "inference-platform").label).toBe("inference-platform");
		expect(layer(undefined, "stack-provenance").label).toBe("stack-provenance");
	});

	it("no row links into a gap map, since this app has none", () => {
		expect(deriveStackXRayLayers(undefined).every((l) => l.mapHref === undefined)).toBe(true);
	});

	it("the model row's Hugging Face link names the Apertus 1.5 card the badge names, not v1", () => {
		const links = PROVENANCE_PRODUCTS.find((p) => p.name === "foundation-model")?.os_product_links;
		expect(links?.find((l) => l.label === "HuggingFace")?.url).toBe(
			"https://huggingface.co/swiss-ai/Apertus-v1.5-70B"
		);
	});

	it("every provenance product has an emoji", () => {
		for (const row of deriveStackXRayLayers(undefined)) {
			expect(row.emoji, `missing emoji for "${row.name}"`).toBeTruthy();
		}
	});

	it("plain answered turn: core pipeline products touched", () => {
		const m = base({
			moderation: { flagged: false, label: null, score: 0, kind: "toxicity", screened: true },
		});
		expect(layer(m, "chat").touched).toBe(true);
		expect(layer(m, "foundation-model").touched).toBe(true);
		expect(layer(m, "trust-and-safety").touched).toBe(true);
		expect(layer(m, "agent-service").touched).toBe(false);
		expect(layer(m, "federated-rag").touched).toBe(false);
		expect(layer(m, "web-search").touched).toBe(false);
		expect(layer(m, "rag").touched).toBe(false);
	});

	it("web-search touched only when the open web actually ran", () => {
		const plain = base();
		expect(layer(plain, "web-search").touched).toBe(false);

		const grounded = base({
			webSearch: {
				query: "q",
				asOf: "2026-01-01",
				sources: [{ n: 1, title: "t", url: "https://example.com", snippet: "", engine: "Wikipedia" }],
			},
		});
		expect(layer(grounded, "web-search").touched).toBe(true);

		const ungrounded = base({ searchAttempt: { grounded: false, searched: true } });
		expect(layer(ungrounded, "web-search").touched).toBe(true);

		const gateDeclined = base({ searchAttempt: { grounded: false, searched: false } });
		expect(layer(gateDeclined, "web-search").touched).toBe(false);
	});

	it("rag touched only when the catalog RAG store hit", () => {
		const plain = base();
		expect(layer(plain, "rag").touched).toBe(false);

		const catalog = base({
			rag: {
				query: "q",
				asOf: "2026-01-01",
				sources: [{ n: 1, title: "t", url: "https://example.com", engine: "Potluck", snippet: "s" }],
			},
		});
		expect(layer(catalog, "rag").touched).toBe(true);
		expect(layer(catalog, "federated-rag").touched).toBe(false);

		const federated = base({
			rag: {
				query: "q",
				asOf: "2026-01-01",
				sources: [{ n: 1, title: "t", url: "https://example.com", engine: "SyftHub", snippet: "s" }],
			},
		});
		expect(layer(federated, "rag").touched).toBe(false);
		expect(layer(federated, "federated-rag").touched).toBe(true);
	});

	it("trust-and-safety not touched when pre-screen failed open", () => {
		const m = base({
			moderation: { flagged: false, label: null, score: 0, kind: "toxicity", screened: false },
		});
		expect(layer(m, "trust-and-safety").touched).toBe(false);
	});

	it("agent-service touched when MCP ran", () => {
		const m = base({ mcp: { tool: "tts" } });
		expect(layer(m, "agent-service").touched).toBe(true);
	});

	it("agent-service touched when the agent ran real ACP tools, with no MCP involvement (CUR-601)", () => {
		const m = base({ agentTools: { toolKinds: ["write_file"] } });
		expect(layer(m, "agent-service").touched).toBe(true);
	});

	it("agent-service not touched when neither MCP nor agent tools ran", () => {
		expect(layer(base(), "agent-service").touched).toBe(false);
	});

	it("voice-output touched only when a TTS clip was actually produced, not on every answer", () => {
		// Read-aloud is hidden: a plain answer produces no audio, so the node must stay dark (it must not
		// light on every answered turn via the always-on set).
		expect(layer(base(), "voice-output").touched).toBe(false);
		// A TTS tool that ran but produced no clip (cold Space / skipped) does not light it either.
		expect(layer(base({ mcp: { tool: "tts" } }), "voice-output").touched).toBe(false);
		// Only a real produced clip lights it.
		const spoken = base({ mcp: { tool: "tts", audio: "https://cdn.example/clip.mp3" } });
		expect(layer(spoken, "voice-output").touched).toBe(true);
	});

	it("federated-rag touched on vault synthesis", () => {
		const m = base({
			rag: { query: "q", asOf: "d", sources: [], vaultSynthesis: "a federated synthesis" },
		});
		expect(layer(m, "federated-rag").touched).toBe(true);
	});

	it("trust-and-safety's maker name links to the maker, and our policy is a separate link labelled as ours (CUR-1745)", () => {
		const m = base();
		const row = layer(m, "trust-and-safety");
		expect(row.partner).toBe("Mistral AI");
		expect(row.partnerLink).toBe("https://mistral.ai");
		expect(row.ownLink).toEqual({ href: "/trust-and-safety", label: "Our Trust & Safety policy" });
	});

	it("chat partner link prefers maintainer url from roadmap data", () => {
		const m = base();
		expect(layer(m, "chat").partnerLink).toBe("https://huggingface.co");
	});

	it("touched layer with os_product shows product attribution", () => {
		const m = base({
			webSearch: {
				query: "q",
				asOf: "2026-01-01",
				sources: [{ n: 1, title: "t", url: "https://example.com", snippet: "", engine: "Wikipedia" }],
			},
		});
		expect(layer(m, "web-search").productAttribution).toBe("Firecrawl");
		expect(layer(m, "web-search").osProduct).toBe("Firecrawl");
	});

	// A flag-gated feature (agent-mode-access) has no row of its own in PROVENANCE_PRODUCTS —
	// it rides on the existing `agent-service` row, so a visitor without access must see something that
	// distinguishes "not built" from "not for you". These pin it: `available` is a THIRD state, independent of `touched` and `status`. (CUR-1447)
	describe("available (CUR-1447: per-user access, distinct from touched/status)", () => {
		it("agent-service defaults to unavailable when the caller passes no flag state (fail-closed)", () => {
			expect(layer(base(), "agent-service").available).toBe(false);
		});

		it("agent-service is available when the caller resolves agentAvailable true, even if untouched", () => {
			const layers = deriveStackXRayLayers(base(), { agentAvailable: true });
			const row = layers.find((l) => l.name === "agent-service")!;
			expect(row.available).toBe(true);
			expect(row.touched).toBe(false);
		});

		it("agent-service is unavailable when the caller resolves agentAvailable false, even if touched", () => {
			// A stale/expired flag mid-conversation: the turn used agent tools, but access is now off.
			// `available` must not be inferred from `touched` — they answer different questions.
			const m = base({ agentTools: { toolKinds: ["write_file"] } });
			const layers = deriveStackXRayLayers(m, { agentAvailable: false });
			const row = layers.find((l) => l.name === "agent-service")!;
			expect(row.touched).toBe(true);
			expect(row.available).toBe(false);
		});

		it("every product NOT behind a per-user flag reports available as undefined, not false", () => {
			// undefined means "not gated" — a real absence signal is `false` and must stay reserved for
			// an actual flag-gated product a user genuinely can't reach, per the header of this file.
			for (const row of deriveStackXRayLayers(base(), { agentAvailable: true })) {
				if (row.name === "agent-service") continue;
				expect(row.available, `expected "${row.name}".available to be undefined`).toBeUndefined();
			}
		});

		it("agent-mode-access still exists in FLAG_KEYS — the declared tie-back this row's `available` resolves", async () => {
			// Runs in Node (vitest), never bundled for the browser — stackXRayLayers.ts itself imports
			// nothing from server/flagKeys.ts (CUR-1447: availability arrives as a resolved boolean prop,
			// never a flag read in client-reachable code). This is what makes "declared from FLAG_KEYS"
			// a checkable fact instead of a comment: rename or remove agent-mode-access without updating
			// StackXRay.svelte's wiring, and this goes red before the drift ships silently.
			const { FLAG_KEYS } = await import("$lib/chat/server/flagKeys");
			const flag = FLAG_KEYS.find((f) => f.key === "agent-mode-access");
			expect(flag, "agent-mode-access must still be a registered flag key").toBeTruthy();
			// The one product this repo currently wires a flag-gated `available` onto — if a future flag
			// gates a new product without adding it to FLAG_GATED_PRODUCTS, this list is where it's missing.
			expect(PROVENANCE_PRODUCTS.some((p) => p.name === "agent-service")).toBe(true);
		});
	});
});

// The panel describes the stack that answered, read from what the endpoint recorded
// (routerMetadata, CUR-2283), not the roadmap's fixed Apertus-through-the-gateway picture. (CUR-2287)
describe("deriveStackXRayLayers follows the served model", () => {
	const INTERMEDIARIES = [
		"inference-platform",
		"compute-router",
		"inference-engine",
		"api-management",
		"sovereign-compute",
	];
	// Sent straight to La Plateforme: the lane is the vendor's own host (CUR-4577).
	const large3 = base({
		routerMetadata: {
			route: "",
			model: "mistral-large-2512",
			backend: "https://api.mistral.ai/v1",
			lane: "api.mistral.ai",
		},
	});
	// Sent to the staging router, which forwards Mistral to La Plateforme: same backend, other lane.
	const large3ViaRouter = base({
		routerMetadata: {
			route: "",
			model: "mistral-large-2512",
			backend: "https://api.mistral.ai/v1",
			lane: "router.stg.aipotluck.org",
		},
	});
	const apertusViaGateway = base({
		routerMetadata: {
			route: "",
			model: "swiss-ai/apertus-v1.5-70b",
			backend: "https://api.inference.cscs.ch/v1",
		},
	});

	it("a Large 3 answer's model row names Mistral Large 3 by Mistral AI and nothing of Apertus's", () => {
		const row = layer(large3, "foundation-model");
		expect(row.touched).toBe(true);
		expect(row.productAttribution).toBe("Mistral Large 3 by Mistral AI");
		expect(row.osProductUrl).toBe(
			"https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512"
		);
		expect(row.provenanceLinks).toEqual([
			{ label: "HuggingFace", url: "https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512" },
		]);
		expect(JSON.stringify(row)).not.toMatch(/apertus|swiss/i);
	});

	it("a Medium answer, the direct lane's backup, links the model row to Medium 3.5's public card (CUR-2460)", () => {
		const medium = base({
			routerMetadata: { route: "", model: "mistral-medium-2604", backend: "https://api.mistral.ai/v1", lane: "api.mistral.ai" },
		});
		const row = layer(medium, "foundation-model");
		expect(row.productAttribution).toBe("Mistral Medium 3.5 by Mistral AI");
		expect(row.osProductUrl).toBe("https://huggingface.co/mistralai/Mistral-Medium-3.5-128B");
		expect(JSON.stringify(row)).not.toMatch(/apertus|swiss/i);
	});

	it("an answer from the maker's own API lights no gateway, router, engine, metering or compute row", () => {
		for (const name of INTERMEDIARIES) expect(layer(large3, name).touched, name).toBe(false);
		expect(layer(large3, "chat").touched).toBe(true);
		expect(layer(large3, "stack-provenance").touched).toBe(true);
	});

	// "not used" on its own read as a confident claim that nothing hosted the model. (CUR-3966)
	it("an answer from the maker's own API names that platform on every row it stood in for, so none reads as plain 'not used' (CUR-3966)", () => {
		for (const name of INTERMEDIARIES) {
			expect(layer(large3, name).bypassedBy, name).toBe("Mistral AI's La Plateforme in France");
		}
		expect(layer(large3, "web-search").bypassedBy).toBeUndefined();
		expect(layer(apertusViaGateway, "inference-engine").bypassedBy).toBeUndefined();
	});

	it("a router.stg turn is never direct (CUR-4577)", () => {
		for (const name of INTERMEDIARIES) {
			expect(layer(large3ViaRouter, name).bypassedBy, name).toBeUndefined();
		}
		expect(JSON.stringify(deriveStackXRayLayers(large3ViaRouter))).not.toMatch(/directly|La Plateforme in France/);
		// The router stood between the app and Mistral, so the router rows read as they do for any routed turn.
		expect(layer(large3ViaRouter, "compute-router").touched).toBe(layer(apertusViaGateway, "compute-router").touched);
	});

	it("a turn with no lane recorded is never called direct, whatever its backend (CUR-4577)", () => {
		const noLane = base({
			routerMetadata: { route: "", model: "mistral-large-2512", backend: "https://api.mistral.ai/v1" },
		});
		for (const name of INTERMEDIARIES) expect(layer(noLane, name).bypassedBy, name).toBeUndefined();
	});

	it("an answer with no recorded backend marks the compute row unreported, never as a reading either way (CUR-3966)", () => {
		expect(layer(base(), "sovereign-compute").unreported).toBe(true);
		expect(layer(apertusViaGateway, "sovereign-compute").unreported).toBeUndefined();
		expect(layer(large3, "sovereign-compute").unreported).toBeUndefined();
		expect(layer(undefined, "sovereign-compute").unreported).toBeUndefined();
	});

	it("an Apertus answer through the gateway keeps the roadmap rows exactly as before", () => {
		for (const name of ["foundation-model", ...INTERMEDIARIES.filter((n) => n !== "sovereign-compute")]) {
			expect(layer(apertusViaGateway, name), name).toEqual(layer(base(), name));
		}
	});

	// The compute row claims Switzerland, so it lights only on a recorded Swiss backend. (CUR-1883)
	it("an Apertus answer from a Swiss backend lights the sovereign-compute row", () => {
		expect(layer(apertusViaGateway, "sovereign-compute").touched).toBe(true);
	});

	it("an answer from Infomaniak lights the compute row naming Infomaniak, with nothing of CSCS's", () => {
		const infomaniak = base({
			routerMetadata: {
				route: "",
				model: "swiss-ai/apertus-v1.5-70b",
				backend: "https://api.infomaniak.com/1/ai/v1",
			},
		});
		const row = layer(infomaniak, "sovereign-compute");
		expect(row.touched).toBe(true);
		expect(row.provenance).toBe("Sovereign compute, hosted by Infomaniak in Switzerland.");
		expect(row.provenanceLinks).toEqual([{ label: "Infomaniak", url: "https://www.infomaniak.com" }]);
		expect(JSON.stringify(row)).not.toMatch(/cscs|lugano|supercomputing/i);
	});

	it("an answer from Phoeniqs names Phoeniqs and links its catalog org, with nothing of CSCS's (CUR-4587)", () => {
		const phoeniqs = base({
			routerMetadata: { route: "", model: "swiss-ai/apertus-v1.5-70b", backend: "https://maas.phoeniqs.com/v1" },
		});
		const row = layer(phoeniqs, "sovereign-compute");
		expect(row.touched).toBe(true);
		expect(row.provenance).toBe("Sovereign compute, hosted by Phoeniqs in Switzerland.");
		expect(row.provenanceLinks).toEqual([{ label: "Phoeniqs", url: "https://phoeniqs.com" }]);
		expect(JSON.stringify(row)).not.toMatch(/cscs|lugano|supercomputing/i);
	});

	it("an answer from CSCS's direct host keeps the roadmap's compute row, as CSCS's own", () => {
		const direct = base({
			routerMetadata: { route: "", model: "swiss-ai/apertus-v1.5-70b", backend: "https://api.swissai.svc.cscs.ch/v1" },
		});
		expect(layer(direct, "sovereign-compute").provenance).toMatch(/hosted by CSCS in Lugano/);
	});

	it("an answer from CSCS keeps the roadmap's compute row", () => {
		expect(layer(apertusViaGateway, "sovereign-compute").provenance).toMatch(/hosted by CSCS in Lugano/);
	});

	it("a turn persisted before the served model was recorded keeps the model row and leaves Swiss compute unclaimed", () => {
		expect(layer(base(), "foundation-model").productAttribution).toMatch(/^Apertus by /);
		expect(layer(base(), "sovereign-compute").touched).toBe(false);
	});
});

// The chips read as claims about this app, so the two rows whose roadmap status says
// otherwise follow what the app runs. (CUR-4328)
describe("deriveStackXRayLayers states what this app runs", () => {
	const autoPicked = base({
		routerMetadata: { route: "", model: "mistral-large-2512", backend: "https://api.mistral.ai/v1" },
		autoRoute: { model: "mistral-large-2512", reasons: [], explanation: "" },
	});
	const handPicked = base({
		routerMetadata: { route: "", model: "mistral-large-2512", backend: "https://api.mistral.ai/v1" },
	});
	const chooser = (m: Message | undefined, autoAvailable: boolean) =>
		deriveStackXRayLayers(m, { autoAvailable }).find((l) => l.name === "model-router")!;

	it("with Auto on, the model chooser is live before any answer, not being built", () => {
		expect(chooser(undefined, true).status).toBe("live");
	});

	it("with Auto on, an answer Auto picked lights the model chooser and a hand-picked one does not", () => {
		expect(chooser(autoPicked, true).touched).toBe(true);
		expect(chooser(handPicked, true).touched).toBe(false);
	});

	it("with Auto off, the model chooser keeps the roadmap's status and never lights", () => {
		const roadmap = PROVENANCE_PRODUCTS.find((p) => p.name === "model-router")!.status;
		expect(chooser(undefined, false).status).toBe(roadmap);
		expect(chooser(autoPicked, false).touched).toBe(false);
	});

	it("public computers is marked idle, never plain working, since no offered model is served from Swiss compute", () => {
		const row = layer(undefined, "sovereign-compute");
		expect(row.idle).toBe(true);
		expect(row.status, "the roadmap's own status is left as it is").toBe("live");
	});

	it("an answer served from Swiss compute still lights public computers as used", () => {
		const swiss = base({
			routerMetadata: { route: "", model: "swiss-ai/apertus-v1.5-70b", backend: "https://api.inference.cscs.ch/v1" },
		});
		expect(layer(swiss, "sovereign-compute").touched).toBe(true);
	});
});
