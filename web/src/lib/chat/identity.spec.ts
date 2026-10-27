import { describe, it, expect } from "vitest";
import {
	resolveModelIdentity,
	servedByBackup,
	servedModelId,
	providerDisplay,
	isLocalModelId,
	describeLocalServer,
} from "./identity";
import { catalog, orgs } from "./routing/catalog";
import { ROLE_MODELS } from "../../../config/inference";

describe("resolveModelIdentity — version brand read from the served checkpoint", () => {
	it("keeps the version brand for the v-prefixed 1.5 release form (Apertus-v1.5-70B)", () => {
		// SNAI ships 1.5 as "apertus-ai/Apertus-v1.5-70B"; the "v" between the dash and the
		// digits must still match, so the badge reads the version and the transparent-swap tester can tell
		// which checkpoint answered (CUR-127).
		const id = resolveModelIdentity("apertus-ai/Apertus-v1.5-70B");
		expect(id.short).toBe("Apertus 1.5 70B");
		expect(id.makerShort).toBe("SNAI");
	});

	it("names the thinking variant apart from its base, and links no card it lacks (CUR-1683)", () => {
		const base = resolveModelIdentity("swiss-ai/apertus-v1.5-70b");
		const thinking = resolveModelIdentity("swiss-ai/apertus-v1.5-70b-thinking");
		expect(base.short).toBe("Apertus 1.5 70B");
		expect(thinking.short).toBe("Apertus 1.5 70B Thinking");
		expect(thinking.card).toBeUndefined();
		expect(base.card).toBe("swiss-ai/apertus-v1.5-70b");
	});

	it("renders the 2509 default as the bare 'Apertus 70B' — no decimal version in the id", () => {
		const id = resolveModelIdentity("swiss-ai/Apertus-70B-Instruct-2509");
		expect(id.short).toBe("Apertus 70B");
		expect(id.makerShort).toBe("SNAI");
	});

	it("names the maker exactly as the model card does — Institute, never Initiative (CUR-152)", () => {
		// This is not a style assertion. `maker` is spliced into the model's own answer to "who made
		// you", so a wrong noun here is a factual error about our supplier delivered in the first
		// sentence a new user reads. The card's acceptable-use agreement is the source:
		//   "The Swiss National AI Institute (SNAI) is a partnership between the two Swiss Federal
		//    Institutes of Technology, ETH Zurich and EPFL."
		// Pinned to the literal string so a future edit has to be deliberate and card-checked; the
		// acronym is the same either way, so nothing else in the codebase can catch a regression here.
		const expected = "the Swiss National AI Institute (SNAI)";
		for (const served of ["apertus-ai/Apertus-v1.5-70B", "swiss-ai/Apertus-70B-Instruct-2509"]) {
			const id = resolveModelIdentity(served);
			expect(id.maker).toBe(expected);
			expect(id.maker).not.toMatch(/Initiative/i);
		}
	});

	it("attributes the GLM fallback lane to Z.ai — a different maker than Apertus", () => {
		// The maker separates a true failover (this) from the same-maker 1.5 swap in servedByBackup.
		const id = resolveModelIdentity("zai-org/GLM-4.6");
		expect(id.makerShort).toBe("Z.ai");
	});

	it("pins the public card to swiss-ai even when 1.5 serves on the gated apertus-ai wire org", () => {
		// The wire org apertus-ai/Apertus-v1.5-70B is a 401 for the public; the released weights live at
		// swiss-ai/Apertus-v1.5-70B, so the badge's model-card + maker links must resolve THERE.
		const id = resolveModelIdentity("apertus-ai/Apertus-v1.5-70B");
		expect(id.card).toBe("swiss-ai/Apertus-v1.5-70B");
	});

	it("leaves the 2509 default card on swiss-ai (wire org already matches — no-op)", () => {
		const id = resolveModelIdentity("swiss-ai/Apertus-70B-Instruct-2509");
		expect(id.card).toBe("swiss-ai/Apertus-70B-Instruct-2509");
	});

	it("gives non-Apertus models no canonical card — badge falls back to the served id", () => {
		const id = resolveModelIdentity("zai-org/GLM-4.6");
		expect(id.card).toBeUndefined();
	});
});

// The empty screen's "Running on …" line reads this name, and the picker shows the routing catalog's
// name, so a gateway model in the catalog must come back under the catalog's spelling
// ("ALIA 40b" must not appear under a picker that says "ALIA 40B").
describe("resolveModelIdentity — a catalog model is named the way the picker names it", () => {
	it.each([
		["BSC-LT/ALIA-40b-instruct", "ALIA 40B"],
		["speakleash/Bielik-11B-v3.0-Instruct", "Bielik 11B v3"],
		["aisingapore/Qwen-SEA-LION-v4-32B-IT", "SEA-LION v4 (Qwen) 32B"],
	])("%s reads as %s", (gatewayId, name) => {
		expect(resolveModelIdentity(gatewayId).short).toBe(name);
	});

	it("still derives a readable name for a model the catalog does not know", () => {
		expect(resolveModelIdentity("acme/Widget-7b-instruct").short).toBe("Widget 7b");
	});
});

// A per-user local (LAN/self-hosted) endpoint's internal id is
// `local:{24-hex endpointId}:{servedModelId}` (localModels.ts). Whenever routerMetadata.model is
// available it's already the labeled string (endpointOai.ts's routerModel param) and never reaches
// this branch at all — this is specifically the floor for the brief window before that's known, where
// the raw conversation model id is all that's available. (CUR-1194/CUR-1262)
describe("resolveModelIdentity — local (LAN/self-hosted) endpoint ids (CUR-1194/CUR-1262)", () => {
	it("strips the local: prefix and endpoint id, leaving just the served model tag", () => {
		const id = resolveModelIdentity("local:20a5be97fcb02afb7ef902d2:llama3.2:latest");
		expect(id.short).toBe("llama3.2:latest");
		expect(id.served).toBe("llama3.2:latest");
	});

	it("does not need a maker claim it can't back", () => {
		const id = resolveModelIdentity("local:20a5be97fcb02afb7ef902d2:llama3.2:latest");
		expect(id.maker).toBe("an open source community");
	});

	it("passes an already-labeled string (endpointId:label already resolved upstream) through unchanged", () => {
		// This is what routerMetadata.model carries once measured — see endpointOai.ts's routerModel.
		const id = resolveModelIdentity("nx16g:llama3.2:latest");
		expect(id.short).toBe("nx16g:llama3.2:latest");
	});

	it("leaves a non-local id alone — no false-positive stripping", () => {
		const id = resolveModelIdentity("swiss-ai/Apertus-70B-Instruct-2509");
		expect(id.short).toBe("Apertus 70B");
	});

	it("leaves a malformed local-shaped id alone (endpoint-id segment isn't 24 hex chars) rather than guessing", () => {
		// Not stripped at all — falls through to the ordinary generic-fallback prettifying (dashes become
		// spaces, same as any other unrecognized id), not a special local: transform.
		const id = resolveModelIdentity("local:not-24-hex:llama3.2:latest");
		expect(id.short).toBe("local:not 24 hex:llama3.2:latest");
	});
});

// ChatIntroduction's empty-state greeting needs to know "is this a local model at all",
// without needing the full parse resolveModelIdentity does — see its own use of this. (CUR-1194)
describe("isLocalModelId", () => {
	it("recognizes a real local model id", () => {
		expect(isLocalModelId("local:20a5be97fcb02afb7ef902d2:llama3.2:latest")).toBe(true);
	});

	it("rejects a catalog id", () => {
		expect(isLocalModelId("swiss-ai/Apertus-70B-Instruct-2509")).toBe(false);
	});

	it("rejects undefined", () => {
		expect(isLocalModelId(undefined)).toBe(false);
	});
});

describe("servedModelId — CUR-125, corrected", () => {
	const requested = "swiss-ai/apertus-v1.5-70b";

	it("prefers a verified router-reported model override over the requested id", () => {
		// A backup lane or an Omni router hop reporting a DIFFERENT model than requested — this is the
		// one case that's an actual verified claim, so it always wins.
		expect(servedModelId({ model: "zai-org/GLM-4.6" }, requested)).toBe("zai-org/GLM-4.6");
	});

	it("falls back to the requested model when only .backend is present — the ordinary healthy gateway turn", () => {
		// The primary CSCS/gateway lane reports its serving backend on every healthy turn and never sends a
		// model-override header, because there is nothing to override. Gating on .model alone (CUR-125)
		// would suppress the badge even though the requested model answered.
		expect(servedModelId({ backend: "https://cscs.example/v1" }, requested)).toBe(requested);
	});

	it("falls back to the requested model when only .provider is present", () => {
		expect(servedModelId({ provider: "publicai" }, requested)).toBe(requested);
	});

	it("suppresses the badge (returns undefined) when routerMetadata is entirely absent — the true unmeasured case", () => {
		expect(servedModelId(undefined, requested)).toBeUndefined();
	});

	it("suppresses the badge when routerMetadata is an empty object", () => {
		expect(servedModelId({}, requested)).toBeUndefined();
	});

	it("returns undefined rather than a garbage value when neither a router signal nor a requested id exists", () => {
		expect(servedModelId(undefined, undefined)).toBeUndefined();
		expect(servedModelId({ backend: "https://cscs.example/v1" }, undefined)).toBeUndefined();
	});
});

// CUR-1017 contract test (Alpha differentiator: "the badge names the model and host"). The model
// half is covered above via resolveModelIdentity/servedModelId; providerDisplay is the other half
// that actually resolves the "host" text a user sees in the provenance chip; a merge silently
// reverting PROVIDER_NAMES to empty would otherwise pass every check.
describe("providerDisplay — the badge's host half (CUR-1017)", () => {
	it("names the known sovereign-inference provider by its friendly name, not the raw slug", () => {
		expect(providerDisplay("publicai")).toBe("Public AI");
		expect(providerDisplay("PUBLICAI")).toBe("Public AI");
	});

	it("title-cases an unrecognized provider slug rather than showing it raw", () => {
		expect(providerDisplay("some-vendor")).toBe("Some-Vendor");
	});

	it("names no provider when none was captured, rather than a configured default (CUR-3562)", () => {
		// A default here would read as the turn's record and be wrong whenever a direct lane or a
		// fallback served the turn.
		expect(providerDisplay(undefined)).toBeUndefined();
		expect(providerDisplay("")).toBeUndefined();
	});

	it("names a local (LAN/self-hosted) endpoint's own venue (CUR-1194)", () => {
		// A local turn never left the user's own network — naming a remote host would
		// be a false provenance claim, not just an unhelpful one.
		expect(providerDisplay("local")).toBe("Local");
	});
});

describe("resolveModelIdentity — a Mistral `-latest` alias whose version went unconfirmed (CUR-2928)", () => {
	it("names Mistral AI and the size, and claims no version, openness or card", () => {
		const id = resolveModelIdentity("mistral-large-latest");
		expect(id).toMatchObject({ short: "Mistral Large (latest)", makerShort: "Mistral AI", openness: "" });
		expect(id.card).toBeUndefined();
	});

	it("does not read as a backup for the dated model it stands for", () => {
		expect(servedByBackup({ model: "mistral-large-latest" }, "mistral-large-2512")).toBe(false);
		expect(servedByBackup({ model: "mistral-small-latest" }, "mistral-small-2603")).toBe(false);
	});
});

describe("resolveModelIdentity — Mistral Large 4, served by the staging router as 2610 (CUR-3027)", () => {
	it("names it Mistral Large 4 from Mistral AI under either name, and claims no openness or card before the weights are out", () => {
		for (const raw of ["mistral-large-2610", "mistralai/mistral-large-2610", "mistral-large-4"]) {
			const id = resolveModelIdentity(raw);
			expect(id).toMatchObject({ short: "Mistral Large 4", makerShort: "Mistral AI", openness: "" });
			expect(id.card).toBeUndefined();
		}
	});

	it("is not mistaken for Large 3", () => {
		expect(resolveModelIdentity("mistral-large-2512").short).toBe("Mistral Large 3");
	});
});

describe("describeLocalServer", () => {
	it("names the server from the label the person gave it", () => {
		expect(describeLocalServer("Workstation:llama3.2:latest", "direct").name).toBe("Workstation");
	});

	it("splits on the FIRST colon, because served ids contain their own", () => {
		// "llama3.2:latest" and "hf.co/owner/repo:Q4_K_M" both do. Splitting on the last colon would
		// put a quantization tag where the panel promises a machine name.
		expect(describeLocalServer("MacBook:hf.co/bartowski/Qwen:Q4_K_M", "direct").name).toBe("MacBook");
	});

	it("falls back to something true when there is no label to read", () => {
		// The panel says "This reply was written by X, your own computer" — X has to read sensibly
		// even when the model list hasn't loaded, rather than naming a machine we're guessing at.
		expect(describeLocalServer(undefined, "direct").name).toBe("your own computer");
		expect(describeLocalServer("", "direct").name).toBe("your own computer");
		expect(describeLocalServer(":llama3.2", "direct").name).toBe("your own computer");
	});

	it("trims a padded label", () => {
		expect(describeLocalServer("  Workstation  :llama3.2", "direct").name).toBe("Workstation");
	});

	it("reports a managed endpoint as managed", () => {
		expect(describeLocalServer("Workstation:m", "managed").managed).toBe(true);
	});

	it("treats an unknown kind as direct, never as tunnelled", () => {
		// The consequential direction. `managed` is what makes the panel promise an encrypted
		// tunnel; defaulting it on for a kind we could not read would be a privacy assurance with
		// nothing behind it. Direct wording promises strictly less, so it is the safe default.
		expect(describeLocalServer("Workstation:m", undefined).managed).toBe(false);
	});
});

describe("servedByBackup — the arithmetic route is not a backup (CUR-3316)", () => {
	const routed = {
		model: "mistral-medium-2604",
		assistedBy: [{ role: "math-route", model: "mistralai/mistral-medium-2604" }]
	};

	it("does not label a turn the arithmetic route handed to the planner's model as a backup", () => {
		expect(servedByBackup(routed, "swiss-ai/apertus-v1.5-70b")).toBe(false);
	});

	it("still labels a cross-maker stand-in that the arithmetic route did not name", () => {
		const other = { ...routed, assistedBy: [{ role: "search-decision", model: "mistral-medium-2604" }] };
		expect(servedByBackup(other, "swiss-ai/apertus-v1.5-70b")).toBe(true);
	});

	it("still labels a turn whose stored failover record says the primary gave up", () => {
		expect(servedByBackup(routed, "swiss-ai/apertus-v1.5-70b", { to: "mistral-medium-2604" })).toBe(true);
	});
});

// The prompt's maker comes from the catalog, so ALIA and Bielik are credited to BSC and
// SpeakLeash as the answer footer credits them, never to "an open source community". (CUR-3836)
describe("resolveModelIdentity — the prompt names the same maker the catalog credits", () => {
	it.each(catalog.filter((m) => m.gatewayId).map((m) => [m.gatewayId!, orgs[m.maker].name]))(
		"%s is made by %s",
		(gatewayId, makerName) => {
			const id = resolveModelIdentity(gatewayId);
			const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
			// "Zhipu AI" vs "Z.ai (Zhipu AI)", "Swiss National AI Institute" vs "the Swiss National AI Institute (SNAI)"
			expect(words(id.maker)).toEqual(expect.arrayContaining(words(makerName)));
		}
	);

	it("names the Barcelona Supercomputing Center for ALIA and SpeakLeash for Bielik, under any provider suffix", () => {
		expect(resolveModelIdentity("BSC-LT/ALIA-40b-instruct").maker).toBe("the Barcelona Supercomputing Center (BSC)");
		expect(resolveModelIdentity("speakleash/Bielik-11B-v3.0-Instruct:plgrid").maker).toBe("SpeakLeash");
	});

	it("tells a swap between ALIA and Bielik apart from no swap", () => {
		expect(resolveModelIdentity("BSC-LT/ALIA-40b-instruct").makerShort).not.toBe(
			resolveModelIdentity("speakleash/Bielik-11B-v3.0-Instruct").makerShort
		);
	});
});

describe("second-opinion panelists", () => {
	it("every panel model is named, never headed by its checkpoint like 'gemma-4-31B-it' (CUR-2203)", () => {
		for (const id of ROLE_MODELS.COMPARE_PANEL) {
			const { short, served } = resolveModelIdentity(id);
			expect(short, id).not.toBe(served);
			expect(short, id).not.toMatch(/[/_]|-it$|-Instruct|-A3B/i);
		}
		expect(resolveModelIdentity("google/gemma-4-31B-it")).toMatchObject({ short: "Gemma 4 31B", makerShort: "Google" });
		expect(resolveModelIdentity("Qwen/Qwen3.6-35B-A3B")).toMatchObject({ short: "Qwen 3.6 35B", makerShort: "Alibaba" });
	});
});
