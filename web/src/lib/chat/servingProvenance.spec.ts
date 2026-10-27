import { describe, it, expect } from "vitest";
import {
	backendDisplay,
	baseURLForModel,
	backendIsSwiss,
	publicModelPage,
	resolveServing,
	sovereignCopyFalsifiedBy,
	swissBackendHosts,
} from "./servingProvenance";
import { PICKER } from "../../../config/picker";

describe("resolveServing", () => {
	const HF = "https://router.huggingface.co/v1";
	// Sovereign hosts are config-driven (SOVEREIGN_HOSTS), not hardcoded — the
	// test supplies one via the spec arg, so no internal infra hostname lives in source.
	// This one is deliberately NOT a SWISS_BACKEND_HOSTS entry — it mirrors the production shape:
	// a routing GATEWAY, config-flagged sovereign, that fans out to a mix of backends per request
	// (CUR-1361).
	const SOV_HOST = "sovereign.example";
	const SOV = `https://${SOV_HOST}/v1`;
	// Deliberately the shape prod ships: an entry whose LABEL names an institution. The sovereign
	// branch must not propagate it, so this spec's job is to prove the label cannot escape into copy.
	const SOV_SPEC = `${SOV_HOST}=CSCS`;
	// A DIRECT connection to a vetted single Swiss backend (no gateway fan-out) — the one shape under
	// which the pre-answer hero/welcome copy can still name Switzerland truthfully, by construction.
	const DIRECT_SWISS_HOST = "api.inference.cscs.ch";
	const DIRECT_SWISS = `https://${DIRECT_SWISS_HOST}/v1`;
	const DIRECT_SWISS_SPEC = `${DIRECT_SWISS_HOST}=CSCS`;

	it("labels the HF router as a non-sovereign prototype host", () => {
		const s = resolveServing(HF, "swiss-ai/Apertus-70B-Instruct-2509");
		expect(s.providerLabel).toBe("HuggingFace");
		expect(s.isSovereign).toBe(false);
		expect(s.servedCheckpoint).toBe("Apertus-70B-Instruct-2509");
		// HF copy keeps the prototype-vs-production hedge (on the hero line).
		expect(s.heroServingLine).toMatch(/served via HuggingFace/i);
		// The map header is panel-descriptive now (not a serving re-assertion) — CSCS lives in the map node.
		expect(s.mapHeaderLine).toMatch(/open source stack/i);
		expect(s.cscsServingNote).toMatch(/not yet from CSCS/i);
		expect(s.routingProvider).toMatch(/HuggingFace/);
	});

	it("labels a config-listed sovereign host as sovereign and drops the prototype hedge", () => {
		const s = resolveServing(SOV, "swiss-ai/Apertus-8B-Instruct-research", SOV_SPEC);
		expect(s.isSovereign).toBe(true);
		expect(s.servedCheckpoint).toBe("Apertus-8B-Instruct-research");
		// Sovereign copy asserts today's routing intent NOW; no "not yet" / "via HuggingFace".
		expect(s.heroServingLine).toMatch(/sovereign infrastructure/i);
		expect(s.heroServingLine).not.toMatch(/HuggingFace/i);
		expect(s.cscsServingNote).not.toMatch(/not yet/i);
	});

	// A gateway lane that fans out to a mix of backends must not claim a specific country pre-answer
	// (CUR-1361). The input is a config-sovereign host that is NOT itself a vetted single Swiss backend,
	// like the production gateway.
	it("does not claim Switzerland on a gateway lane that can route to a non-Swiss backend", () => {
		const s = resolveServing(SOV, "swiss-ai/Apertus-70B-Instruct-2509", SOV_SPEC);
		const copy = [s.computeTail, s.heroServingLine, s.welcomeServingLine, s.routingProvider].join(" | ");
		expect(copy).not.toMatch(/switzerland/i);
	});

	// Contract (CUR-75): a gateway lane picks a backend per request, so no pre-turn string may name the
	// institution that will run the turn. Naming CSCS on every turn is wrong for the share of turns another
	// backend serves. If this test ever passes vacuously, check that SOV_SPEC still supplies an institution
	// name for the branch to swallow.
	it("names NO institution in the gateway lane's copy, not even the one the config label supplies", () => {
		const s = resolveServing(SOV, "swiss-ai/Apertus-70B-Instruct-2509", SOV_SPEC);
		const copy = [
			s.computeTail,
			s.heroServingLine,
			s.welcomeServingLine,
			s.mapHeaderLine,
			s.routingProvider,
			s.providerLabel,
		].join(" | ");
		expect(copy).not.toMatch(/CSCS/i);
		expect(copy).not.toMatch(/Infomaniak/i);
		// …and it must not have gone silent on sovereignty entirely — the lane-intent claim survives.
		expect(s.computeTail).toMatch(/sovereign infrastructure/i);
	});

	// A DIRECT single-backend Swiss connection is the one shape where the specific pre-answer claim
	// stays true by construction — no gateway fan-out to hide behind. Today's production config has no
	// such lane (CSCS-direct retired, CUR-162), but the branch has to keep working for when it returns.
	it("keeps today's exact Switzerland sentence for a DIRECT connection to a vetted Swiss backend", () => {
		const s = resolveServing(DIRECT_SWISS, "swiss-ai/Apertus-70B-Instruct-2509", DIRECT_SWISS_SPEC);
		expect(s.isSovereign).toBe(true);
		expect(s.heroServingLine).toBe(
			"This prototype runs on sovereign public compute in Switzerland, routed by the Public AI Inference Utility."
		);
		expect(s.computeTail).toBe("served on sovereign public compute in Switzerland.");
	});

	// A lane that can route to a commercial backend must not say "not a company": the claim is false on
	// exactly the turns that backend serves.
	it("does not claim 'not a company' on a lane that can route to a commercial backend", () => {
		const s = resolveServing(SOV, "swiss-ai/Apertus-70B-Instruct-2509", SOV_SPEC);
		expect(s.heroServingLine).not.toMatch(/not a company/i);
		expect(s.welcomeServingLine).not.toMatch(/not a company/i);
	});

	// The greeting reads computeTail, not providerLabel; the direct-host branch keeps naming its host because
	// there the label IS the compute.
	it("gives the greeting a clause it can render without touching providerLabel", () => {
		expect(resolveServing(HF, "swiss-ai/Apertus-70B-Instruct-2509").computeTail).toMatch(
			/served via HuggingFace/i
		);
		expect(
			resolveServing(DIRECT_SWISS, "swiss-ai/Apertus-70B-Instruct-2509", DIRECT_SWISS_SPEC).computeTail
		).toMatch(/sovereign public compute in Switzerland/i);
	});

	it("deep-links the served checkpoint only when its HF page is public", () => {
		// Public 2509 build → deep-link to its model page.
		expect(resolveServing(HF, "swiss-ai/Apertus-70B-Instruct-2509").checkpointUrl).toBe(
			"https://huggingface.co/swiss-ai/Apertus-70B-Instruct-2509"
		);
		// Private CSCS research build (401 on HF) → fall back to the public org
		// page, never a dead deep-link. The checkpoint NAME still shows elsewhere.
		expect(
			resolveServing(SOV, "swiss-ai/Apertus-8B-Instruct-research", SOV_SPEC).checkpointUrl
		).toBe("https://huggingface.co/swiss-ai");
		// 1.5 serves under the GATED wire org apertus-ai/… (401), but its public weights are
		// swiss-ai/Apertus-v1.5-70B — deep-link to the public repo, not the gated wire path.
		expect(resolveServing(HF, "apertus-ai/Apertus-v1.5-70B").checkpointUrl).toBe(
			"https://huggingface.co/swiss-ai/Apertus-v1.5-70B"
		);
	});

	// The contract: recognising a public checkpoint must not depend on how the LANE cases its wire id. 1.5 is
	// served as `apertus-ai/Apertus-v1.5-70B` or as the gateway's `swiss-ai/apertus-v1.5-70b` (CUR-162); a
	// case-sensitive lookup would miss, and the control would silently downgrade to the org page — which is
	// also what a genuinely unpublished checkpoint produces, so the assertion above would stay green. Two live
	// wire ids, both directions.
	it("recognises a public checkpoint whatever case the lane sends — the org-page fallback must mean UNPUBLISHED, not unrecognised", () => {
		// The id prod actually sends for 1.5 today (APERTUS_15_MODEL), lowercased by the gateway.
		expect(resolveServing(SOV, "swiss-ai/apertus-v1.5-70b", SOV_SPEC).checkpointUrl).toBe(
			"https://huggingface.co/swiss-ai/Apertus-v1.5-70B"
		);
		// And the canonical casing keeps working, so the fix is not a swap of one blind spot for another.
		expect(resolveServing(SOV, "swiss-ai/Apertus-v1.5-70B", SOV_SPEC).checkpointUrl).toBe(
			"https://huggingface.co/swiss-ai/Apertus-v1.5-70B"
		);
		// The primary's wire id is the gateway's ROUTING-GROUP alias, not a repo — huggingface.co returns 401 for
		// it, so the org page is the correct answer and must stay.
		expect(resolveServing(SOV, "swiss-ai/apertus-70b-instruct", SOV_SPEC).checkpointUrl).toBe(
			"https://huggingface.co/swiss-ai"
		);
	});

	it("fails honest on an unknown host: no invented provider, treated as non-sovereign", () => {
		const s = resolveServing("https://example.com/v1", "some/model");
		expect(s.providerLabel).toBe("example.com");
		expect(s.isSovereign).toBe(false);
		expect(s.heroServingLine).toMatch(/served via example\.com/i);
	});

	it("does not leak develop's own hostname into visible copy (CUR-1629)", () => {
		const s = resolveServing("https://develop.aipotluck.org/folkways-adapter/v1", "some/model");
		expect(s.providerLabel).toBe("a preview environment");
		expect(s.isSovereign).toBe(false);
		expect(s.heroServingLine).not.toMatch(/develop\.aipotluck\.org/i);
	});

	it("names La Plateforme in France, not the app's own host, when the Mistral lane goes through the Folkways adapter (CUR-3186)", () => {
		const direct = resolveServing("https://api.mistral.ai/v1", "mistral-large-2512");
		for (const base of [
			"https://mozfest.aipotluck.org/folkways-adapter/mistral/v1",
			"https://mozfest.aipotluck.org/folkways-adapter/mistral/v1/",
		]) {
			const s = resolveServing(base, "mistral-large-2512");
			expect(s, base).toEqual(direct);
			expect(s.heroServingLine).not.toMatch(/aipotluck\.org/i);
		}
		// resolveServing alone still names the gateway route's own host; baseURLForModel unwraps it
		// to the adapter's upstream before it gets here (CUR-3573, below).
		expect(resolveServing("https://mozfest.aipotluck.org/folkways-adapter/v1", "x").providerLabel).toBe(
			"mozfest.aipotluck.org"
		);
	});

	it("names the adapter's upstream, never the instance's own host, when the base is the Folkways gateway route (CUR-3573)", () => {
		const ADAPTER = "https://mozfest.aipotluck.org/folkways-adapter/v1";
		const apertus = { endpoints: [{ type: "openai", baseURL: ADAPTER }] };
		for (const base of [ADAPTER, `${ADAPTER}/`]) {
			// As mozfest is configured: the adapter forwards to the sovereign gateway.
			const viaSov = resolveServing(baseURLForModel(undefined, base, SOV), "x", SOV_SPEC);
			expect(viaSov, base).toEqual(resolveServing(SOV, "x", SOV_SPEC));
			expect(viaSov.heroServingLine).not.toMatch(/aipotluck\.org/i);
		}
		// A model's own endpoint on the gateway route unwraps the same way.
		expect(baseURLForModel(apertus, undefined, SOV)).toBe(SOV);
		// Upstream unset (or blank): the adapter's own default, HF's router.
		expect(baseURLForModel(undefined, ADAPTER)).toBe(HF);
		expect(baseURLForModel(undefined, ADAPTER, "  ")).toBe(HF);
		// The Mistral adapter route and any other base pass through untouched.
		const MISTRAL_ROUTE = "https://mozfest.aipotluck.org/folkways-adapter/mistral/v1";
		expect(baseURLForModel(undefined, MISTRAL_ROUTE, SOV)).toBe(MISTRAL_ROUTE);
		expect(baseURLForModel(undefined, SOV, HF)).toBe(SOV);
		expect(baseURLForModel(undefined, "not a url", SOV)).toBe("not a url");
	});

	it("names a model the staging router doesn't forward in words, never its staging hostname (CUR-3573)", () => {
		const s = resolveServing("https://router.stg.aipotluck.org/v1", "BSC-LT/ALIA-40b-instruct");
		expect(s.providerLabel).toBe("a staging router");
		expect(s.heroServingLine).not.toMatch(/aipotluck\.org/i);
		expect(s.welcomeServingLine).not.toMatch(/aipotluck\.org/i);
	});

	it("a Mistral model through the staging router says Mistral in France and never public compute (SOL-288)", () => {
		for (const id of ["mistral-medium-2604", "mistral-large-2512"]) {
			const s = resolveServing("https://router.stg.aipotluck.org/v1", id);
			expect(s.providerLabel).toBe("Mistral AI's La Plateforme");
			expect(s.directCountry).toBe("France");
			expect(s.isSovereign).toBe(false);
			for (const line of [s.computeTail, s.heroServingLine, s.welcomeServingLine]) {
				expect(line).toContain("Mistral AI's La Plateforme in France");
				expect(line).not.toMatch(/public compute|sovereign|staging/i);
			}
		}
	});

	it("degrades gracefully with no base URL or model id", () => {
		const s = resolveServing(undefined, undefined);
		expect(s.providerLabel).toBe("the configured endpoint");
		expect(s.isSovereign).toBe(false);
		expect(s.servedCheckpoint).toBe("the configured model");
	});

	it("never claims LUMI in the welcome copy (TODO A24, 2026-07-01): dropped from product copy, this was stale", () => {
		expect(resolveServing(HF, "swiss-ai/Apertus-70B-Instruct-2509").welcomeServingLine).not.toMatch(
			/LUMI/i
		);
		expect(
			resolveServing(SOV, "swiss-ai/Apertus-8B-Instruct-research", SOV_SPEC).welcomeServingLine
		).not.toMatch(/LUMI/i);
	});
});

// The measured half. resolveServing states what the DEPLOYMENT claims before a turn; these read what
// the gateway reported after one, and are the only things that can falsify the claim.
describe("backend allowlist (the falsifier for the sovereign-compute copy)", () => {
	const CSCS = "https://api.inference.cscs.ch/v1";
	const INFOMANIAK = "https://api.infomaniak.com/2/ai/106744/openai/v1";

	it("accepts both backends production is measured to route to", () => {
		expect(backendIsSwiss(CSCS)).toBe(true);
		expect(backendIsSwiss(INFOMANIAK)).toBe(true);
	});

	// The red condition. endpointOai warns on exactly this, and it is the moment the shipped "sovereign public
	// compute in Switzerland" copy becomes false: the same routing group can have a Singapore source (CUR-75),
	// so this is a route that has really existed.
	it("rejects a backend outside Switzerland, and rejects garbage rather than defaulting true", () => {
		expect(backendIsSwiss("https://api.example.sg/v1")).toBe(false);
		expect(backendIsSwiss(undefined)).toBe(false);
		expect(backendIsSwiss("not a url")).toBe(false);
		// The gateway's own host is NOT a backend — believing it was is the whole bug.
		expect(backendIsSwiss("https://api-internal.publicai.co/v1")).toBe(false);
	});

	// What the allowlist alone gets wrong. `backendIsSwiss` answers a question about a HOST; the copy
	// makes a claim about the user's ANSWER, and the same client carries every side-call.
	describe("sovereignCopyFalsifiedBy", () => {
		const OFF_ALLOWLIST = "https://api-internal-intel.publicai.co/olmo/v1";

		it("is false for a side-call on a non-Swiss backend — the copy is about the answer", () => {
			// The false positive this predicate exists to prevent, using the real host and the real model: the
			// second-opinion panel fans out to Olmo and EuroLLM BECAUSE Public AI doesn't host them, as a side-call,
			// while the answers those turns produce come from CSCS. Flag them and the first red this check ever
			// produced would be a wrong one — about a turn that was served from Switzerland.
			expect(sovereignCopyFalsifiedBy({ backend: OFF_ALLOWLIST, servesUserAnswer: false })).toBe(
				false
			);
		});

		it("is true for the ANSWER on a non-Swiss backend — the failure it is named for", () => {
			expect(sovereignCopyFalsifiedBy({ backend: OFF_ALLOWLIST, servesUserAnswer: true })).toBe(
				true
			);
			// Singapore was a real source for this routing group (CUR-75).
			expect(
				sovereignCopyFalsifiedBy({ backend: "https://api.example.sg/v1", servesUserAnswer: true })
			).toBe(true);
		});

		it("stays quiet on a Swiss answer and on a turn with no measured backend at all", () => {
			expect(sovereignCopyFalsifiedBy({ backend: CSCS, servesUserAnswer: true })).toBe(false);
			expect(sovereignCopyFalsifiedBy({ backend: INFOMANIAK, servesUserAnswer: true })).toBe(false);
			// No header means the gateway told us nothing — absence of a measurement is not a falsehood,
			// and warning on it would make every non-LiteLLM lane (HF router, agent) permanently red.
			expect(sovereignCopyFalsifiedBy({ backend: undefined, servesUserAnswer: true })).toBe(false);
		});
	});

	it("names an allowlisted backend and stays silent on one it has not vetted", () => {
		expect(backendDisplay(CSCS)).toMatch(/CSCS/);
		expect(backendDisplay(INFOMANIAK)).toMatch(/Infomaniak/);
		expect(backendDisplay("https://api.example.sg/v1")).toBeUndefined();
		expect(backendDisplay(undefined)).toBeUndefined();
	});

	// CUR-996. The HF fallback lane serves from api.featherless.ai and api.sea-lion.ai (neither Swiss), and
	// the badge must not go silent on them: backendDisplay and backendIsSwiss read separate maps, so naming a
	// backend never makes it Swiss. These two tests pin that: one proves the silence is gone, the other proves
	// naming a backend can never make it Swiss.
	it("names a non-Swiss backend rather than going silent", () => {
		expect(backendDisplay("https://api.featherless.ai/v1")).toMatch(/Featherless/);
		expect(backendDisplay("https://api.sea-lion.ai/v1")).toMatch(/Singapore/);
	});

	it("a displayable backend is not thereby Swiss", () => {
		expect(backendIsSwiss("https://api.featherless.ai/v1")).toBe(false);
		expect(backendIsSwiss("https://api.sea-lion.ai/v1")).toBe(false);
		// The allowlist itself must still name exactly the vetted Swiss hosts — not every host that
		// happens to have a display name now.
		expect(swissBackendHosts().sort()).toEqual([
			"api.inference.cscs.ch",
			"api.infomaniak.com",
			"api.swissai.svc.cscs.ch",
			"maas.phoeniqs.com",
		]);
	});
});

// A model offered in the picker without a card on the list shows its name in X-ray as plain text, so a
// visitor cannot check the weights behind the answer. Each offered model links its public card, or says
// here why it has none (CUR-3864).
describe("publicModelPage covers every model a picker offers", () => {
	const NO_PUBLIC_CARD: Record<string, string> = {
		"BSC-LT/ALIA-40b-instruct": "the served repo answers 401 on Hugging Face (CUR-3913)",
		"mistral-large-2610": "Mistral Large 4's weights are not published yet (CUR-3027)",
	};

	it("every offered model links its Hugging Face card or is listed as having none (CUR-3864)", () => {
		const offered = [...new Set(Object.values(PICKER).flat())];
		const unlinked = offered.filter((id) => !publicModelPage(id) && !(id in NO_PUBLIC_CARD));
		expect(unlinked).toEqual([]);
	});

	it("a SEA-LION v4.8 answer links its public card (CUR-3864)", () => {
		expect(publicModelPage("aisingapore/Nemotron-SEA-LION-v4.8-120B-A12B")).toBe(
			"https://huggingface.co/aisingapore/Nemotron-SEA-LION-v4.8-120B-A12B"
		);
	});
});
