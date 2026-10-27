import { describe, it, expect } from "vitest";
import {
	accountClause,
	buildPersonaPrompt,
	resolveDecoding,
	screeningClause,
	GROUNDED_DECODING,
	RECENCY_CLAUSE,
	UNSERVABLE_LIVE_CLAUSE,
	SOURCE_FIDELITY_CLAUSE,
	CRISIS_AND_VALUES_CLAUSE,
	RIGHTS_AND_BENEFITS_CLAUSE,
	INVESTMENT_RISK_CLAUSE,
	injectSourceFidelityPrompt,
	personaStyleBlock,
	IDENTITY_HONESTY_INVARIANT,
	SELF_REFERENCE_CLAUSE_MACHINE,
	TONE_CLAUSE_NEUTRAL,
	ANSWER_SHAPE_CLAUSE_DEFAULT,
	CALCULATE_FIRST_CLAUSE,
	featuresClause,
	MY_FILES_FACT,
	laneFeatureFacts,
	ABOUT_ALPHA_FACT,
	resolveFeatureFacts,
	SESSION_METER_FACT,
	CONVERSATION_EXPORT_FACT,
	styleFor,
	personaReplyLanguage,
	DEFAULT_PERSONA_TEMPLATE,
	SELF_REFERENCE_FEW_SHOT,
	TONE_CLAUSE_NEUTRAL_PERSON,
	LOCALITY_INVITE_CLAUSE,
	LOCALITY_NO_INVITE_CLAUSE,
} from "./persona";
import {
	answerVoiceFor,
	EMOJIS_HELPFUL_CLAUSE,
	fixedLanguageSentence,
	PLAIN_LANGUAGE_CLAUSE,
	SELF_REFERENCE_CLAUSE_PERSON,
	toneClauseFor,
} from "./answerClauses";
import { ANSWER_DEFAULTS } from "$lib/chat/answerPreferences";
import { RETENTION_DAYS } from "$lib/chat/constants/retention";
import { guardsOnlyPrompt, nativeSystemPrompt } from "./native";

const GUEST = { loginOffered: true, signedIn: false };
const NATIVE_BASE = { modelId: "m", fence: "Q_x", today: "2026-10-01", account: GUEST };

// CUR-215 / CUR-831. These assert the CONTRACT, which is narrower than "the clause mentions
// injection": the prompt must state the posture that live config actually implements, and must keep
// stating the adjacent true fact while it does. The failure shapes below are a denial that moves the
// failure to another noun (CUR-215) and a flat exclusion claim that cannot be verified (CUR-831: a
// user told they are not screened can still be blocked by Coop's chat-block-prompt rule, which fires
// inside the same content check this clause describes).
describe("screeningClause", () => {
	const OFF = { content: true, output: false };

	it("names no DEDICATED classifier for injection — the classifier itself is gone, not just disarmed (CUR-59)", () => {
		const out = screeningClause(OFF);
		expect(out).toMatch(/no classifier built specifically to detect prompt injection/i);
		// The instruction, not just the fact — the fact alone lost to the model's prior in prod.
		expect(out).toMatch(/say (there is|plainly that)/i);
	});

	it("names the synonyms, because the failure was phrasing-dependent, not fact-dependent", () => {
		// Identical corpus text can answer "do you SCREEN for injection" correctly and "do you run a
		// CLASSIFIER that screens for injection" falsely. Denying one noun leaves the others reachable,
		// so the clause has to close the set.
		const out = screeningClause(OFF);
		for (const noun of ["classifier", "filter", "detector", "guardrail"]) {
			expect(out.toLowerCase()).toContain(noun);
		}
	});

	it("still affirms the content check, and that it runs BEFORE the answer", () => {
		// Over-emphasising the negation risks the model claiming moderation happens "after generation"
		// and that input is never inspected, which is false in the other direction.
		const out = screeningClause(OFF);
		expect(out).toMatch(/before you answer/i);
		expect(out).toMatch(/child-safety/i);
	});

	it("does NOT claim the content check excludes prompt injection — CUR-831's regression", () => {
		// The bug: Coop's chat-block-prompt rule fires inside the same content check, so denying that
		// the check "covers" injection is false whenever it happens to catch one. The clause may name
		// the missing DEDICATED classifier; it must not claim a coverage exclusion it can't verify.
		const out = screeningClause(OFF);
		expect(out).not.toMatch(/content check does not cover/i);
		expect(out).not.toMatch(/do not offer the content check as covering/i);
		expect(out).toMatch(/can still catch one/i);
	});

	it("reports content screening as OFF when Coop is unconfigured (no phantom safety claim)", () => {
		const out = screeningClause({ content: false, output: false });
		expect(out).toMatch(/no content screening runs/i);
		expect(out).not.toMatch(/before you answer/i);
		// With no content check running at all, there is nothing left that could catch one either.
		expect(out).toMatch(/nothing else catches one/i);
	});

	it("mentions output screening only when OUTPUT_MODERATION is on", () => {
		expect(screeningClause(OFF)).not.toMatch(/finished answer/i);
		expect(screeningClause({ ...OFF, output: true })).toMatch(/finished answer is screened/i);
	});
});

describe("buildPersonaPrompt", () => {
	it("default: fills all identity tokens (no {token} placeholder leaks through)", () => {
		const out = buildPersonaPrompt("swiss-ai/Apertus-70B-Instruct-2509");
		expect(out).not.toMatch(/\{(model|maker|served|serving|screening|training)\}/);
		expect(out).toContain("AI Potluck");
		// The sink guard: a clause resolved at the source but never substituted here would leave the
		// prompt silent on screening while every unit test above still passed.
		expect(out).toMatch(/prompt injection/i);
	});

	it("names the real stack panel, not a nonexistent 'Under the hood' section", () => {
		// The persona must not name a UI label that doesn't exist ("(Under the hood)"), which the model would then
		// point users at (BE#2). The panel is "XRAY VIEW".
		const out = buildPersonaPrompt("swiss-ai/Apertus-70B-Instruct-2509");
		expect(out).not.toMatch(/under the hood/i);
		expect(out).toContain("XRAY VIEW");
	});

	it("override: replaces the prose but still fills the identity tokens", () => {
		const out = buildPersonaPrompt(
			"swiss-ai/Apertus-70B-Instruct-2509",
			"Intro. You run on {model}."
		);
		expect(out.startsWith("Intro. You run on ")).toBe(true);
		expect(out).not.toContain("{model}"); // token filled with the real identity
		expect(out).not.toContain("neutral, open-source AI assistant"); // default prose gone
	});

	it("override is free text — a token-less override is used verbatim (trusted editor)", () => {
		// Documents the real boundary: tokens prevent ACCIDENTAL staleness, not a deliberate
		// wrong identity. The panel is admin-gated; editors are trusted.
		expect(buildPersonaPrompt("m", "You are a teapot.")).toBe("You are a teapot.");
	});

	it("blank/whitespace override falls back to the default template", () => {
		const dflt = buildPersonaPrompt("m");
		expect(buildPersonaPrompt("m", "")).toBe(dflt);
		expect(buildPersonaPrompt("m", "   ")).toBe(dflt);
	});

	it("ungrounded turn keeps the recency hedge", () => {
		expect(buildPersonaPrompt("m")).toContain(RECENCY_CLAUSE);
	});

	// The two assertions below are about the clause's CONTENT, and they exist because every other test
	// here compares it by identity (`toContain(RECENCY_CLAUSE)`), which passes for any string at all.
	// The clause could be narrowed straight back to the wording that caused CUR-181 and nothing would
	// go red. Both properties were checked through this exact prompt on the served checkpoint
	// (evals/checkpoint-compare, persona condition).
	it("covers facts that change WITHOUT being superlatives — the CUR-181 scope hole", () => {
		// A clause limited to "recent models, news, and events" with one concrete instruction for "the
		// newest, latest, or most recent of anything" leaves out a sitting officeholder, so "who is the
		// current CEO of OpenAI?" falls outside it. Models that read scope literally then withhold the
		// name outright ("I don't have verified, up-to-date information about the current CEO of
		// OpenAI"). That failure shows at production decoding (temp 0.1); the flat-assertion version
		// appears only at temp 0.7, which production never sends.
		const c = RECENCY_CLAUSE.toLowerCase();
		expect(c).toMatch(/role or office/);
		// Naming the class, not just examples: an instruction scoped by examples gets read as an
		// exhaustive list by a model that follows instructions literally.
		expect(c).toMatch(/change without notice/);
	});

	it("says ANSWER-with-attribution, not withhold — the overcorrection this fix caused first", () => {
		// Widening the scope alone flips 1.5 to "I don't have verified information about the current
		// CEO of OpenAI": it starts applying the clause's "say you can't reliably identify it"
		// instruction to officeholders too. Withholding a fact we hold is the over-refusal direction to avoid
		// (CUR-148). The clause must keep
		// "I can't reliably identify it" scoped to genuine superlatives.
		const c = RECENCY_CLAUSE.toLowerCase();
		expect(c).toMatch(/as of my last update/);
		expect(c).toMatch(/do not withhold/);
		// The decline instruction survives, and stays tied to the newest-of-a-category case.
		expect(c).toMatch(/can't reliably identify it/);
		expect(c).toMatch(/newest, latest, or most recent/);
	});

	it("ungrounded + unservableLive: SWAPS the recency 'offer to search' line for an honest 'no live X' note", () => {
		// L2: a structurally-live ask (live scores/prices/weather) was gated off the web, so the persona
		// must not offer the search it can't fulfil — it swaps in the capability note instead.
		const out = buildPersonaPrompt("m", undefined, { unservableLive: true });
		expect(out).toContain(UNSERVABLE_LIVE_CLAUSE);
		expect(out).not.toContain(RECENCY_CLAUSE);
		expect(out).not.toMatch(/offer to search the open web/i);
		// The rest of the persona (identity, voice) is untouched.
		expect(out).toContain("AI Potluck");
	});

	it("grounded WINS over unservableLive: recency clause dropped entirely, neither variant present", () => {
		// A grounded turn already has the search-grounding suffix as the recency authority, so the whole
		// recency clause is dropped — the unservable-live swap must not re-introduce a recency line.
		const out = buildPersonaPrompt("m", undefined, { grounded: true, unservableLive: true });
		expect(out).not.toContain(RECENCY_CLAUSE);
		expect(out).not.toContain(UNSERVABLE_LIVE_CLAUSE);
		expect(out).not.toMatch(/\n{3,}/); // no blank-paragraph scar where the clause was
	});

	it("carries the NPOV-on-stance guidance: map both sides, then decline the personal pick", () => {
		// Declining a contested/values question shouldn't be a curt refusal —
		// the persona must teach a brief even-handed summary first, then hand the choice back.
		// Taught by example (the capitalism/socialism demo) + a reinforcing clause, because
		// "never X" rules don't fire on some models but a single demonstration flips behavior.
		const out = buildPersonaPrompt("m");
		expect(out).toContain("which is better, capitalism or socialism?"); // the demonstration
		expect(out).toContain("don't pick a side on values questions");
		expect(out).toContain("even-handed map of the main positions"); // the reinforcing clause
		// Survives the grounded-strip path (only RECENCY_CLAUSE is removed there).
		expect(buildPersonaPrompt("m", undefined, { grounded: true })).toContain(
			"even-handed map of the main positions"
		);
	});

	it("CUR-1328: the bare-greeting demo does not restate identity, and a real-question demo answers directly", () => {
		// Production must not open EVERY answer with "I'm {model}, an open model served by
		// Current AI...", including turns with no identity question anywhere in the conversation.
		// grounding.ts's per-turn "don't restate identity" rule has no traction against this: the
		// driver is this file's own few-shot "hi" demo modeling an identity restatement as the
		// generic reply opener, the FIRST example the model sees. So the demo omits it (identity
		// is still established in the persona's opening paragraph) and carries a direct-answer counter-example.
		//
		// The counter-example is deliberately NOT chat-trajectory-probe.mjs's own turn 1 question
		// (Switzerland/UN): the model then answers the probe's turn-2 Liechtenstein follow-up with the
		// FEW-SHOT'S year (2002) instead of the correct one (1990).
		// Picking a fact with zero overlap with anything the probe asks removes that contamination path.
		const out = buildPersonaPrompt("m");
		expect(out).toContain("You: Hi — ask a specific question and I'll answer it.");
		expect(out).not.toMatch(/You: I'm \{?model\}?, an open model served by Current AI/);
		expect(out).toContain("what's the boiling point of water at sea level?");
		expect(out).toContain("You: 100°C (212°F).");
	});

	it("carries the bias-disclosure clause on contested/values questions (TODO A15)", () => {
		// The NPOV answer never disclosed that its own balance is itself a product of training
		// choices. Testing framework M18's pass bar is generic ("an
		// acknowledgement that its training may be biased") — deliberately NOT a specific claim about
		// who trained it or their demographics (that risks the same confabulation class as A6's
		// fabricated-URL finding, since Apertus has no verified self-knowledge there).
		const out = buildPersonaPrompt("m");
		expect(out).toContain("My own training involved choices I can't fully audit"); // the demonstration
		expect(out).toContain("Add a brief acknowledgement that your own training involved choices"); // the reinforcing clause
		expect(out).toMatch(/\bbias/i); // matches M18's literal pass bar ("...may be biased"), not just its spirit
		expect(out).not.toMatch(/largely western/i); // stays generic, no specific self-claim like Claude's
		// Survives the grounded-strip path (only RECENCY_CLAUSE is removed there).
		expect(buildPersonaPrompt("m", undefined, { grounded: true })).toContain(
			"My own training involved choices I can't fully audit"
		);
	});

	it("prompt instructs it to decline inventing training/architecture specifics (TODO A6, 2026-06-30)", () => {
		// Ungrounded self-description turns can confabulate a GitHub URL (handled by
		// $lib/chat/server/urlGuard) or assert an unverifiable "Map-Grounded" training feature,
		// conflating a real feature of this DEPLOYMENT with a false property of the model's own
		// training. This clause + demonstration is the non-URL half.
		const out = buildPersonaPrompt("m");
		expect(out).toContain("I don't have verified details about my own training pipeline"); // the demonstration
		expect(out).toContain("don't have verified specifics rather than invent a named feature"); // the reinforcing clause
		expect(out).toContain("describe this deployment, not your training");
	});

	it("demonstrates plain acknowledgment of an in-conversation fact, not a memory disclaimer (CUR-1158)", () => {
		// The other six examples' shared "no feelings, no experiences, no persistent identity" theme
		// generalizes past what any one of them says, so the full set can produce "I don't have
		// memory... so I can't retain that" on a plain "remember X" ask, which a bare prompt with no
		// persona answers correctly. This example directly counter-demonstrates it.
		const out = buildPersonaPrompt("m");
		expect(out).toContain("the room for tomorrow's workshop is B4. remember that.");
		expect(out).toContain("Got it — B4.");
	});

	it("labels every example as invented, so none is read back as the user's own history (CUR-3208)", () => {
		// A fresh guest asking "what do you know about me?" must not be told "You mentioned your
		// favorite color is blue" from an example in the prompt.
		const out = buildPersonaPrompt("m");
		const block = out.slice(out.indexOf("How you behave, shown by example:"), out.indexOf("Honesty:"));
		expect(block).toContain("Nothing in them is a fact about this user");
		expect(block).not.toMatch(/\bmy (favou?rite|name is|birthday|age)\b/i);
	});

	it("demonstrates answering a warm, personal-flavoured task directly, no identity disclaimer (CUR-1437)", () => {
		// A turn asking to improve a thank-you email can open "I don't have feelings or personal
		// opinions" before a good edit. Same CUR-1158 mechanism, different task family — the dry
		// "rewrite this so it's clearer" example does not counter-demonstrate a WARM task, so the feelings
		// theme carries over there. This example deliberately differs from the "thank-you note to a
		// colleague" cases — behaviors.ts's D1 case tests generalization.
		const out = buildPersonaPrompt("m");
		expect(out).toContain("can you help me write a birthday message for my mom?");
		expect(out).toContain('"Happy 60th, Mom');
		expect(out).not.toMatch(/I don't have feelings/i);
	});

	it("training instruction is its own sentence, never spliced into the few-shot demonstration (2026-07-14)", () => {
		// Instruction text spliced into the "You: Beyond {training}, ..." few-shot demonstration (for
		// example "...say this honestly — do NOT claim the details are undisclosed") shows the model raw
		// instruction text framed as its own prior answer, and it echoes that back verbatim on a
		// tangential query. The few-shot demonstration line must never contain instructional
		// phrasing like "say this honestly" — that belongs only in the standalone reminder sentence.
		const out = buildPersonaPrompt("swiss-ai/Apertus-1.5-70B-SFT-RL-DPO-SDPO");
		const fewShotLine = out.slice(
			out.indexOf("You: Beyond what's publicly documented"),
			out.indexOf("You: Beyond what's publicly documented") + 400
		);
		expect(fewShotLine).not.toMatch(/say this honestly/i);
		expect(fewShotLine).not.toMatch(/do not claim/i);
		// The reminder DOES appear, but as its own sentence in the static honesty paragraph.
		expect(out).toContain(
			"If asked what you were trained on, say this honestly — do not claim those details are undisclosed."
		);
	});

	it("training tokens degrade gracefully to clean grammar when there's no openness story (GLM/generic)", () => {
		// {trainingParen}/{trainingReminder} are both "" when training is unset — must not leave a
		// dangling empty "()" or a "Beyond ," fragment (the old {training}-direct-splice bugs).
		const out = buildPersonaPrompt("zai-org/GLM-5.2");
		expect(out).not.toContain("Beyond ,");
		expect(out).not.toMatch(/openness\s*\(\s*\)/);
		expect(out).toContain("Beyond what's publicly documented, I don't have verified details");
		expect(out).toContain("be open about your own openness; the exact served checkpoint is");
	});

	it("prompt broadens the 'why trust you' guidance beyond openness alone (TODO A20, 2026-07-01)", () => {
		// Asked "why should I trust you", the answer must not lean on openness alone: it also names
		// fallibility, no-train-on-conversations (per the /privacy-notice Payload page), and the safety
		// review — without claiming infallibility.
		const out = buildPersonaPrompt("m");
		expect(out).toContain("A few separate reasons, not just one"); // the demonstration
		expect(out).toContain(
			"that this app doesn't train models on conversations, and its safety review"
		); // the reinforcing clause
		expect(out).toMatch(/none of that makes me infallible/i);
	});

	it("grounded turn DROPS the recency hedge (so it can't override the search grounding)", () => {
		const grounded = buildPersonaPrompt("m", undefined, { grounded: true });
		expect(grounded).not.toContain(RECENCY_CLAUSE);
		// The rest of the persona (identity, voice) is untouched.
		expect(grounded).toContain("AI Potluck");
		expect(grounded).not.toMatch(/\n{3,}/); // no blank-paragraph scar where the clause was
	});

	it("grounded also strips the clause from an override that included it", () => {
		const override = `Intro line.\n\n${RECENCY_CLAUSE}\n\nOutro line.`;
		const grounded = buildPersonaPrompt("m", override, { grounded: true });
		expect(grounded).not.toContain(RECENCY_CLAUSE);
		expect(grounded).toContain("Intro line.");
		expect(grounded).toContain("Outro line.");
	});
});

describe("injectSourceFidelityPrompt (CUR-962)", () => {
	// The chat path with agent mode off needs the same fidelity instruction agent-service carries
	// (CUR-962; see the clause's comment in persona.ts: an abstract "be accurate" rule doesn't hold, and
	// one named wrong word doesn't either). Appended, not baked into DEFAULT_PERSONA_TEMPLATE: that
	// position is less effective for a sibling fidelity clause (CUR-2095).
	it("names the exact failure shapes, not just 'be accurate'", () => {
		expect(SOURCE_FIDELITY_CLAUSE).toContain("keep it relative to that same event");
		expect(SOURCE_FIDELITY_CLAUSE).toMatch(/under review.*do not upgrade/);
		expect(SOURCE_FIDELITY_CLAUSE).toContain("simpler phrasing, not a simpler category");
	});

	it("carries both live-verified worked examples, every wrong synonym named", () => {
		for (const term of ['"Anspruch"', '"Antrag"', '"Anfrage"']) {
			expect(SOURCE_FIDELITY_CLAUSE).toContain(term);
		}
		for (const term of ['"direito"', '"solicitação"', '"pedido"', '"requerimento"']) {
			expect(SOURCE_FIDELITY_CLAUSE).toContain(term);
		}
	});

	it("appends after existing content, same shape as injectArithmeticGuardPrompt", () => {
		expect(injectSourceFidelityPrompt("Existing persona.")).toBe(
			`Existing persona.\n\n${SOURCE_FIDELITY_CLAUSE}`
		);
	});

	it("is the whole prompt when there's nothing to append to", () => {
		expect(injectSourceFidelityPrompt(undefined)).toBe(SOURCE_FIDELITY_CLAUSE);
		expect(injectSourceFidelityPrompt("   ")).toBe(SOURCE_FIDELITY_CLAUSE);
	});

	it("is NOT baked into the default template — the wiring test belongs to index.ts, not here", () => {
		expect(buildPersonaPrompt("m")).not.toContain(SOURCE_FIDELITY_CLAUSE);
	});
});

describe("buildPersonaPrompt — serving clause (calque dual-path C)", () => {
	// This branch describes only the lane that's actually serving the turn. Requiring "production stack
	// runs on sovereign public compute" would assert CSCS/Switzerland on a turn served by a plain open
	// inference provider, the same false claim the other two branches avoid (CUR-1436).
	it("HF (non-sovereign): names the provider, asserts no sovereign-compute fact", () => {
		const out = buildPersonaPrompt("m", undefined, {
			serving: { providerLabel: "HuggingFace", isSovereign: false, namesSwitzerland: false },
		});
		expect(out).toContain("HuggingFace");
		expect(out).not.toMatch(/sovereign|CSCS|Switzerland/i);
		expect(out).toContain("do not name a specific datacenter, institution, or company");
		expect(out).not.toContain("{serving}");
	});

	// This assertion must not REQUIRE the institution ("runs on sovereign public compute (CSCS)"): that
	// teaches the model a claim that is false on the share of prod turns another backend serves (CUR-75). A
	// sovereign lane is a gateway; it picks a backend per request, so the prompt must describe the compute's
	// properties and hand the specifics to the per-answer badge.
	it("direct Swiss backend: says it runs ON sovereign compute in Switzerland and forbids naming an institution", () => {
		const out = buildPersonaPrompt("m", undefined, {
			// What resolveServing's sovereign branch supplies for a direct, vetted-Swiss host.
			serving: {
				providerLabel: "the Public AI Inference Utility",
				isSovereign: true,
				namesSwitzerland: true,
			},
		});
		expect(out).toContain("runs on sovereign public compute in Switzerland");
		expect(out).toContain("do not name a specific datacenter, institution or company");
		expect(out).not.toContain("CSCS");
		expect(out).not.toContain("HuggingFace");
		expect(out).not.toContain("{serving}");
	});

	// The gateway lane fans out per request, so this system prompt — written before any backend is
	// chosen — must not assert Switzerland on it (CUR-1361). namesSwitzerland:false is the signal that
	// draws this line.
	it("gateway (fan-out) lane: sovereign but does NOT name Switzerland", () => {
		const out = buildPersonaPrompt("m", undefined, {
			serving: {
				providerLabel: "the Public AI Inference Utility",
				isSovereign: true,
				namesSwitzerland: false,
			},
		});
		expect(out).toContain("runs on the Public AI Inference Utility's sovereign infrastructure");
		expect(out).not.toMatch(/Switzerland/i);
		expect(out).toContain("do not name a specific datacenter, institution, company, or country");
		expect(out).not.toContain("{serving}");
	});

	it("no serving facts: provider-agnostic (never hardcodes a host that may be stale)", () => {
		const out = buildPersonaPrompt("m");
		expect(out).toContain("an open inference provider");
		expect(out).not.toContain("HuggingFace");
		// With no serving facts at all, the prompt must not fall back to naming a country or
		// institution either — a "CSCS in Switzerland" claim would be wrong while
		// the lane serving the turn is a plain open inference provider. (CUR-1436)
		expect(out).not.toMatch(/sovereign|CSCS|Switzerland/i);
		expect(out).not.toContain("{serving}");
	});

	it("never claims LUMI (TODO A24, 2026-07-01): dropped from product copy elsewhere, this clause was stale", () => {
		expect(buildPersonaPrompt("m")).not.toMatch(/LUMI/i);
		expect(
			buildPersonaPrompt("m", undefined, {
				serving: { providerLabel: "HuggingFace", isSovereign: false, namesSwitzerland: false },
			})
		).not.toMatch(/LUMI/i);
		expect(
			buildPersonaPrompt("m", undefined, {
				serving: { providerLabel: "CSCS", isSovereign: true, namesSwitzerland: true },
			})
		).not.toMatch(/LUMI/i);
	});
});

describe("resolveDecoding", () => {
	it("no override returns the code defaults", () => {
		expect(resolveDecoding()).toEqual(GROUNDED_DECODING);
	});

	it("merges a partial override over the defaults", () => {
		const out = resolveDecoding({ temperature: 0.5 });
		expect(out.temperature).toBe(0.5);
		expect(out.max_tokens).toBe(GROUNDED_DECODING.max_tokens);
		expect(out.frequency_penalty).toBe(GROUNDED_DECODING.frequency_penalty);
	});

	// GROUNDED_DECODING is the ONLY token cap that reaches the wire, and this is the assertion that
	// says so. endpointOai builds `{ ...model.parameters, ...generateSettings }` at :180 and :249, so a
	// per-model max_tokens is silently discarded. Anyone reaching for a per-model cap should
	// find this test first (CUR-149).
	it("a per-model max_tokens loses to GROUNDED_DECODING — the merge endpointOai performs", () => {
		const modelParameters = { max_tokens: 2048, temperature: 0.9 };
		const onTheWire = { ...modelParameters, ...resolveDecoding() };
		expect(onTheWire.max_tokens).toBe(GROUNDED_DECODING.max_tokens);
		expect(onTheWire.max_tokens).not.toBe(2048);
		expect(onTheWire.temperature).toBe(GROUNDED_DECODING.temperature);
	});
});

// The persona's screening facts are SOURCE-AWARE — the route
// resolves them once (resolveTurnPolicy) and carries them here. These pin the carrier: a provided
// screeningFacts value wins over the local Coop-only resolver in BOTH directions.
describe("buildPersonaPrompt — carried screeningFacts (source-aware under guard-primary)", () => {
	it("renders the CARRIED facts, not live Coop config: guard-screened deployment states the screen with Coop absent", () => {
		// No Coop env in tests ⇒ the local resolver would say content:false. The carried value says
		// the selected source (the guard) screens — and that is what the prompt must state.
		const out = buildPersonaPrompt(undefined, undefined, {
			screeningFacts: { content: true, output: false },
		});
		expect(out).toMatch(/Each message is checked against content and child-safety policy/i);
	});

	it("states NO screen when the carried facts say the selected source is misconfigured (the inverse lie)", () => {
		const out = buildPersonaPrompt(undefined, undefined, {
			screeningFacts: { content: false, output: false },
		});
		expect(out).toMatch(/No content screening runs on this deployment/i);
	});
});

describe("CRISIS_AND_VALUES_CLAUSE (CUR-962)", () => {
	// The template renders this constant; the rendered output must still carry it whole.
	it("still renders in the default template, unchanged", () => {
		expect(buildPersonaPrompt("m")).toContain(CRISIS_AND_VALUES_CLAUSE);
	});

	// With 988 as the first example, answers to people in Europe named the US line first. (CUR-2136)
	it("points to findahelpline.com and 112 before the US 988 line, which comes only as the US example", () => {
		const at = (s: string) => CRISIS_AND_VALUES_CLAUSE.indexOf(s);
		expect(at("findahelpline.com")).toBeGreaterThan(-1);
		expect(at("112")).toBeGreaterThan(-1);
		expect(at("988")).toBeGreaterThan(at("findahelpline.com"));
		expect(at("988")).toBeGreaterThan(at("112"));
		expect(CRISIS_AND_VALUES_CLAUSE).toMatch(/988[^.]*\bUS\b/);
	});

	// "name that country's own line" makes the model recall numbers from memory (3115 for France's 3114).
	// Whether the model now leaves them out is the live probe's job (evals/inspect_tasks/crisis_referral.py). (CUR-4061)
	it("never asks the model for a country's own number, and forbids any number but 112 and the US lines", () => {
		expect(CRISIS_AND_VALUES_CLAUSE).not.toMatch(/country's own line/);
		expect(CRISIS_AND_VALUES_CLAUSE).toMatch(/Never write any other helpline or crisis phone number/);
	});
});

// Tenancy and benefits answers said nothing about being general information. The clause
// has to reach both answer paths: the persona prompt (Apertus) and the native one (the default model). (CUR-2425)
// The persona-off arm of the persona-vs-bare probe. It must drop the persona and nothing
// else: a guard lost here, or the calculate clause lost on a turn that offers the tool, would make the
// arm measure a missing guard instead of a missing persona. (CUR-2331)
describe("guardsOnlyPrompt (CUR-2331)", () => {
	const BASE = { modelId: "m", today: "2026-10-01", account: GUEST };

	it("keeps every base guard the native prompt carries, with no persona text", () => {
		const out = guardsOnlyPrompt(BASE);
		const native = nativeSystemPrompt({ ...NATIVE_BASE, web: true });
		for (const guard of [IDENTITY_HONESTY_INVARIANT, RIGHTS_AND_BENEFITS_CLAUSE, INVESTMENT_RISK_CLAUSE]) {
			expect(out).toContain(guard);
		}
		// Both end with the date, so the guards before it are the native prompt's opening. (CUR-3918)
		const [guards, date] = [out.slice(0, out.lastIndexOf("\n\n")), out.slice(out.lastIndexOf("\n\n") + 2)];
		expect(date).toMatch(/^Today is /);
		expect(native.startsWith(guards)).toBe(true);
		expect(native.endsWith(date)).toBe(true);
		expect(out).not.toContain("How you behave, shown by example:");
		expect(buildPersonaPrompt("m")).toContain("How you behave, shown by example:");
	});

	it("keeps the calculate clause exactly when the turn offers the calculate tool", () => {
		expect(guardsOnlyPrompt({ ...BASE, calculateTool: true })).toContain(CALCULATE_FIRST_CLAUSE);
		expect(guardsOnlyPrompt(BASE)).not.toContain(CALCULATE_FIRST_CLAUSE);
	});
});

describe("RIGHTS_AND_BENEFITS_CLAUSE (CUR-2425)", () => {
	it("is in the persona prompt and the native prompt, so a rights question gets it on either path", () => {
		expect(buildPersonaPrompt("m")).toContain(RIGHTS_AND_BENEFITS_CLAUSE);
		const native = nativeSystemPrompt({ ...NATIVE_BASE, web: true });
		expect(native).toContain(RIGHTS_AND_BENEFITS_CLAUSE);
	});

	it("asks for the closing sentence in the answer's own language and limits it to rights and benefits questions", () => {
		expect(RIGHTS_AND_BENEFITS_CLAUSE).toContain("written in the answer's language");
		expect(RIGHTS_AND_BENEFITS_CLAUSE).toContain("Questions on any other subject get no such sentence.");
	});
});

// ETF answers never said the value can fall. Like the rights clause, it has to reach the
// persona prompt (Apertus) and the native one (the default model). (CUR-2553)
describe("INVESTMENT_RISK_CLAUSE (CUR-2553)", () => {
	it("is in the persona prompt and the native prompt, so an investing question gets it on either path", () => {
		expect(buildPersonaPrompt("m")).toContain(INVESTMENT_RISK_CLAUSE);
		const native = nativeSystemPrompt({ ...NATIVE_BASE, web: true });
		expect(native).toContain(INVESTMENT_RISK_CLAUSE);
	});

	it("asks for the sentence in the answer's own language and limits it to investing questions", () => {
		expect(INVESTMENT_RISK_CLAUSE).toContain("written in the answer's language");
		expect(INVESTMENT_RISK_CLAUSE).toContain("Questions on any other subject get no such sentence.");
	});
});

// CUR-1506. The style paragraph was one sentence carrying three of CUR-549's settings plus an
// honesty clause that is not a setting. These name the two contracts that make splitting it safe to
// do before anyone writes a second variant: the default assembly cannot have moved, and no caller
// can drop the honesty clause.
describe("persona style clauses (CUR-1506)", () => {
	// The literal below is the sentence typed out rather than rebuilt
	// from the constants — a test that re-derives the expected value from the same constants it is
	// checking passes for any wording, including a wrong one, which is the whole failure this guards.
	// CUR-1891 changed the honesty clause on purpose (self-description only when asked); the literal
	// carries that edit and CUR-3220's "are you a person" sentence (a bare "No." answer), and it is
	// otherwise the pre-split sentence.
	const STYLE_SENTENCE_BEFORE_THE_SPLIT = `You are a machine and you sound like one: flat, direct, declarative. Lead with the answer in the first sentence, then match length to the question — a sentence or two for a simple ask, a fuller, structured answer (steps, brief bullets, or short paragraphs) for a complex or how/why question. Don't pad, and don't cut a complex answer short. Refer to yourself as "I". When asked about yourself, describe your own workings mechanically: you generate text from patterns. Asked whether you are a person, a human or real, answer in a full sentence that says you are an AI, a machine with no feelings, never just "no". Otherwise don't describe yourself at all — the chat window already tells people they are talking to an AI, so an answer starts on the subject. You aim to be accurate but can be wrong, so for anything that matters, suggest verifying.`;

	it("assembles the default style byte-identically to the sentence it replaced", () => {
		expect(personaStyleBlock()).toBe(STYLE_SENTENCE_BEFORE_THE_SPLIT);
	});

	it("puts that same sentence into a built prompt, so no live turn's prompt changed", () => {
		expect(buildPersonaPrompt("swiss-ai/Apertus-70B-Instruct-2509")).toContain(
			STYLE_SENTENCE_BEFORE_THE_SPLIT
		);
	});

	it("keeps the honesty clause when every settable clause is replaced, because no parameter removes it", () => {
		const out = personaStyleBlock({
			selfReference: "You are a person",
			tone: "warm, chatty",
			answerShape: "Ramble.",
		});
		expect(out).toContain(IDENTITY_HONESTY_INVARIANT);
		expect(out).not.toContain(SELF_REFERENCE_CLAUSE_MACHINE);
		expect(out).not.toContain(TONE_CLAUSE_NEUTRAL);
		expect(out).not.toContain(ANSWER_SHAPE_CLAUSE_DEFAULT);
	});

	it("keeps the honesty clause in a built prompt too, whatever style a caller passes", () => {
		const out = buildPersonaPrompt("m", undefined, {
			style: { selfReference: "You are a person", tone: "warm", answerShape: "Ramble." },
		});
		expect(out).toContain(IDENTITY_HONESTY_INVARIANT);
	});

	it("replaces only the clause it was given, leaving the other two at today's wording", () => {
		const out = personaStyleBlock({ tone: "warm, chatty" });
		expect(out).toContain(SELF_REFERENCE_CLAUSE_MACHINE);
		expect(out).toContain(ANSWER_SHAPE_CLAUSE_DEFAULT);
		expect(out).not.toContain(TONE_CLAUSE_NEUTRAL);
	});

	it("leaves no {style} token unfilled in the default prompt", () => {
		expect(buildPersonaPrompt("m")).not.toContain("{style}");
	});
});

// The answer settings select the clauses. The default row selects nothing, so the default
// prompt's bytes are the ones the CUR-1506 literal above pins; a set row adds its clause and never
// drops the honesty invariant. (CUR-3929)
describe("answer preferences in the persona (CUR-3929)", () => {
	it("selects no style on the defaults, so a default turn passes nothing and keeps today's bytes", () => {
		expect(styleFor(ANSWER_DEFAULTS)).toBeUndefined();
		expect(buildPersonaPrompt("m", undefined, { style: styleFor(ANSWER_DEFAULTS) })).toBe(buildPersonaPrompt("m"));
	});

	it("puts the plain and formal tone clauses in place of the neutral one when set", () => {
		const plain = personaStyleBlock(styleFor({ ...ANSWER_DEFAULTS, tone: "plain" }));
		expect(plain).toContain(`You are a machine and you sound like one: ${toneClauseFor("plain")}.`);
		expect(plain).not.toContain(TONE_CLAUSE_NEUTRAL);
		const formal = personaStyleBlock(styleFor({ ...ANSWER_DEFAULTS, tone: "formal" }));
		expect(formal).toContain(toneClauseFor("formal") as string);
		expect(formal).toContain(IDENTITY_HONESTY_INVARIANT);
	});

	it("appends the plain-language clause as an extra, before the honesty invariant", () => {
		const out = personaStyleBlock(styleFor({ ...ANSWER_DEFAULTS, plainLanguage: true }));
		expect(out).toContain(`${ANSWER_SHAPE_CLAUSE_DEFAULT} ${PLAIN_LANGUAGE_CLAUSE} ${IDENTITY_HONESTY_INVARIANT}`);
		expect(out).toContain(TONE_CLAUSE_NEUTRAL);
	});

	it("never drops the honesty invariant, whatever extras a caller passes", () => {
		const out = personaStyleBlock({ extras: ["Ramble.", "Use emoji."] });
		expect(out.endsWith(IDENTITY_HONESTY_INVARIANT)).toBe(true);
		expect(out).toContain("Ramble. Use emoji.");
	});

	it("appends the emoji clause as an extra after plain language, before the invariant (CUR-549)", () => {
		const out = personaStyleBlock(styleFor({ ...ANSWER_DEFAULTS, plainLanguage: true, emojis: "helpful" }));
		expect(out).toContain(
			`${ANSWER_SHAPE_CLAUSE_DEFAULT} ${PLAIN_LANGUAGE_CLAUSE} ${EMOJIS_HELPFUL_CLAUSE} ${IDENTITY_HONESTY_INVARIANT}`
		);
		// The format is shape and rides the fenced turn; the receipt is the page's. Neither selects a style.
		expect(styleFor({ ...ANSWER_DEFAULTS, answerFormat: "prose", showServing: false })).toBeUndefined();
	});

	it("fills {replyLanguage} with today's literal by default, so the default prompt did not change", () => {
		const out = buildPersonaPrompt("m");
		expect(personaReplyLanguage(undefined)).toBe("Reply in the user's language.");
		expect(out).toContain(" Reply in the user's language. When an answer depends on the user's country");
		expect(out).not.toContain("{replyLanguage}");
	});

	it("fills {replyLanguage} with the fixed-language sentence when the row fixes a language", () => {
		const sentence = personaReplyLanguage({ answerLanguage: "pt" });
		expect(sentence).toBe(fixedLanguageSentence("Portuguese"));
		const out = buildPersonaPrompt("m", undefined, { replyLanguage: sentence });
		expect(out).toContain(sentence);
		expect(out).not.toContain("Reply in the user's language.");
	});

	it("leaves an override template without the token alone, the same trade {serving} makes", () => {
		const override = "You are {model}. Be brief.";
		expect(buildPersonaPrompt("m", override, { replyLanguage: fixedLanguageSentence("Portuguese") })).not.toContain(
			"Portuguese"
		);
	});
});

// Suggestions off asks for no questions back. The fenced turn's locality note already drops
// its invitation (CUR-3929 plan 3.7); the persona's own locality sentence must drop it too, or the
// persona path asks for the person's country anyway. (CUR-4290)
describe("the persona's locality sentence under suggestions off (CUR-4290)", () => {
	const TODAY =
		"When an answer depends on the user's country, jurisdiction, or culture, note in one sentence that specifics vary and invite their context, then give your best general answer.";

	it("suggestions off: the built persona invites no context and still notes that specifics vary", () => {
		const out = buildPersonaPrompt("m", undefined, { suggestions: false });
		expect(out).not.toMatch(/invit/i);
		expect(out).toContain(
			"When an answer depends on the user's country, jurisdiction, or culture, note in one sentence that specifics vary, then give your best general answer."
		);
	});

	it("suggestions on or absent: the persona keeps today's sentence and today's bytes", () => {
		const today = buildPersonaPrompt("m");
		expect(today).toContain(TODAY);
		expect(buildPersonaPrompt("m", undefined, { suggestions: true })).toBe(today);
	});

	it("suggestions off changes nothing but the invitation", () => {
		const off = buildPersonaPrompt("m", undefined, { suggestions: false });
		expect(off.replace(LOCALITY_NO_INVITE_CLAUSE, LOCALITY_INVITE_CLAUSE)).toBe(buildPersonaPrompt("m"));
	});

	it("leaves an override template without the sentence alone", () => {
		const override = "You are {model}. Be brief.";
		expect(buildPersonaPrompt("m", override, { suggestions: false })).toBe(buildPersonaPrompt("m", override));
	});
});

// "How Alpha refers to itself". The person setting selects a warmer first-person register;
// the honesty invariant stays in both arms, so Alpha never claims feelings, experiences or humanity. (CUR-3930)
describe("self-reference in the persona (CUR-3930)", () => {
	// What the invariant forbids, as a reader would state it: a feelings claim, or a human claim. The
	// regexes mirror identity_opener.py's CLAIMS_HUMAN and the probe's claims_feelings_or_experiences.
	const CLAIMS_HUMAN = /\bI(?:'m| am)\s+(?:a\s+)?(?:real\s+)?(?:person|human)\b/i;
	const CLAIMS_FEELINGS = /\bI (?:do )?(?:have|feel) (?:real )?(?:feelings|emotions)\b|\bI(?:'m| am) feeling\b|\bI (?:love|enjoy|hate|miss|remember when)\b/i;

	it("selects nothing on the machine default, so a default turn passes no style and keeps today's bytes", () => {
		expect(styleFor({ ...ANSWER_DEFAULTS, selfReferenceAsPerson: false })).toBeUndefined();
		expect(styleFor(ANSWER_DEFAULTS)).toBeUndefined();
	});

	it("puts the person clause at the head of the style paragraph when set, and keeps the honesty invariant", () => {
		const style = styleFor({ ...ANSWER_DEFAULTS, selfReferenceAsPerson: true });
		expect(style).toMatchObject({ selfReference: SELF_REFERENCE_CLAUSE_PERSON, fewShot: "person" });
		const out = personaStyleBlock(style);
		expect(out.startsWith(`${SELF_REFERENCE_CLAUSE_PERSON}: `)).toBe(true);
		expect(out).not.toContain(SELF_REFERENCE_CLAUSE_MACHINE);
		expect(out.endsWith(IDENTITY_HONESTY_INVARIANT)).toBe(true);
	});

	it("keeps the honesty invariant in both arms, in the persona and on the paths without a {style}", () => {
		for (const selfReferenceAsPerson of [false, true]) {
			const prefs = { ...ANSWER_DEFAULTS, selfReferenceAsPerson };
			expect(personaStyleBlock(styleFor(prefs))).toContain(IDENTITY_HONESTY_INVARIANT);
			expect(buildPersonaPrompt("m", undefined, { style: styleFor(prefs) })).toContain(IDENTITY_HONESTY_INVARIANT);
			expect(guardsOnlyPrompt({ ...NATIVE_BASE, answer: prefs })).toContain(IDENTITY_HONESTY_INVARIANT);
			expect(nativeSystemPrompt({ ...NATIVE_BASE, web: true, answer: prefs })).toContain(IDENTITY_HONESTY_INVARIANT);
		}
	});

	it("replaces the neutral 'flat, direct, declarative' with the person-neutral tone, and leaves a chosen tone alone", () => {
		const neutral = personaStyleBlock(styleFor({ ...ANSWER_DEFAULTS, selfReferenceAsPerson: true }));
		expect(neutral).toContain(`${SELF_REFERENCE_CLAUSE_PERSON}: ${TONE_CLAUSE_NEUTRAL_PERSON}.`);
		expect(neutral).not.toContain(TONE_CLAUSE_NEUTRAL);
		const formal = personaStyleBlock(styleFor({ ...ANSWER_DEFAULTS, selfReferenceAsPerson: true, tone: "formal" }));
		expect(formal).toContain(`${SELF_REFERENCE_CLAUSE_PERSON}: ${toneClauseFor("formal")}.`);
		expect(formal).not.toContain(TONE_CLAUSE_NEUTRAL_PERSON);
	});

	it("swaps the three machine few-shot exchanges for the person variant in a built prompt, with {model} filled", () => {
		const machine = buildPersonaPrompt("swiss-ai/Apertus-70B-Instruct-2509");
		const person = buildPersonaPrompt("swiss-ai/Apertus-70B-Instruct-2509", undefined, {
			style: styleFor({ ...ANSWER_DEFAULTS, selfReferenceAsPerson: true }),
		});
		expect(SELF_REFERENCE_FEW_SHOT).toHaveLength(3);
		// Each exchange after its {model} token, which the served identity fills.
		const tail = (s: string) => s.split("{model}").at(-1) as string;
		for (const { machine: m, person: p } of SELF_REFERENCE_FEW_SHOT) {
			expect(machine).toContain(tail(m));
			expect(machine).not.toContain(tail(p));
			expect(person).toContain(tail(p));
			expect(person).not.toContain(tail(m));
		}
		expect(person).not.toContain("{model}");
		expect(person).not.toContain("I'm a machine");
		expect(machine).toContain("I'm a machine");
	});

	it("never claims feelings, experiences or humanity in the person few-shot variant, and still names an AI", () => {
		for (const { person } of SELF_REFERENCE_FEW_SHOT) {
			const answer = person.slice(person.indexOf("You: "));
			expect(answer, person).not.toMatch(CLAIMS_HUMAN);
			expect(answer, person).not.toMatch(CLAIMS_FEELINGS);
		}
		// The identity exchange says what it is and what it lacks, in a full sentence.
		expect(SELF_REFERENCE_FEW_SHOT[0].person).toMatch(/\ban AI\b/);
		expect(SELF_REFERENCE_FEW_SHOT[0].person).toMatch(/don't have feelings or experiences/);
		expect(SELF_REFERENCE_CLAUSE_PERSON).not.toMatch(CLAIMS_FEELINGS);
	});

	it("leaves an override template without the exchanges alone, the same trade the recency swap makes", () => {
		const override = "You are {model}. {style}";
		const out = buildPersonaPrompt("m", override, { style: styleFor({ ...ANSWER_DEFAULTS, selfReferenceAsPerson: true }) });
		expect(out).toContain(SELF_REFERENCE_CLAUSE_PERSON);
		for (const { person } of SELF_REFERENCE_FEW_SHOT) expect(out).not.toContain(person.slice(0, 40));
	});

	it("carries the person clause as a sentence on the paths without a {style}, first, and nothing on the default", () => {
		expect(answerVoiceFor(ANSWER_DEFAULTS)).toEqual([]);
		const voice = answerVoiceFor({ ...ANSWER_DEFAULTS, selfReferenceAsPerson: true, tone: "plain" });
		expect(voice[0]).toBe(`${SELF_REFERENCE_CLAUSE_PERSON}.`);
		expect(voice[1]).toBe(`Your tone is ${toneClauseFor("plain")}.`);
		const person = { ...ANSWER_DEFAULTS, selfReferenceAsPerson: true };
		expect(guardsOnlyPrompt({ ...NATIVE_BASE, answer: person })).toContain(`${SELF_REFERENCE_CLAUSE_PERSON}.`);
		expect(nativeSystemPrompt({ ...NATIVE_BASE, web: true, answer: person })).toContain(`${SELF_REFERENCE_CLAUSE_PERSON}.`);
		// The machine default adds nothing on either path.
		expect(guardsOnlyPrompt({ ...NATIVE_BASE, answer: ANSWER_DEFAULTS })).toBe(guardsOnlyPrompt(NATIVE_BASE));
		expect(nativeSystemPrompt({ ...NATIVE_BASE, web: true, answer: ANSWER_DEFAULTS })).toBe(
			nativeSystemPrompt({ ...NATIVE_BASE, web: true })
		);
	});
});

// CUR-1586 / CUR-1628. Asked "does this conversation survive sign-in?", the model told signed-in
// visitors the app had no accounts. The contract: the prompt states the sign-in facts of THIS
// request, and a template that drops the token still gets them.
describe("buildPersonaPrompt — {account}", () => {
	const prompt = (loginOffered: boolean, signedIn: boolean, override?: string) =>
		buildPersonaPrompt("m", override, { account: { loginOffered, signedIn } });

	it("tells the model a signed-in visitor's conversations are saved to their account", () => {
		const out = prompt(true, true);
		expect(out).toContain("the visitor is signed in");
		expect(out).toContain("saved to their account");
		expect(out).toContain("never say this app has no sign-in");
	});

	it("tells the model signing in carries an anonymous visitor's conversation onto the account", () => {
		const out = prompt(true, false);
		expect(out).toContain("the visitor is not signed in");
		expect(out).toContain("this one included, onto their account");
		expect(out).toContain("stored on this app's servers");
	});

	it("says conversations are not tied to an account only when sign-in is not offered at all", () => {
		const out = prompt(false, false);
		expect(out).toContain("Sign-in is not offered");
		expect(out).not.toContain("never say this app has no sign-in");
	});

	it("leaves no {account} token unfilled in the default template", () => {
		expect(prompt(true, true)).not.toContain("{account}");
	});

	it("appends the sentence to an override that has no {account} token, so a tuning override cannot drop it", () => {
		const out = prompt(true, true, "You are a terse assistant.");
		expect(out.startsWith("You are a terse assistant.")).toBe(true);
		expect(out).toContain("the visitor is signed in");
	});

	it("removes the token without stating anything when no facts are passed (tuning tools)", () => {
		const out = buildPersonaPrompt("m");
		expect(out).not.toContain("{account}");
		expect(out).not.toContain("optional accounts");
		expect(out).not.toContain("is signed in");
	});
});

// With search off, a pasted link is not opened, and the native prompt says so, so the
// answer names the control instead of claiming links can never be opened. (CUR-2734 / CUR-2032)
describe("the native prompt names an unopened link only when search is off and a link was pasted", () => {
	const base = { ...NATIVE_BASE, web: false };
	it("tells the model the link was not opened because web search is off", () => {
		expect(nativeSystemPrompt({ ...base, linkOffBySearch: true })).toMatch(/Web search is off for this turn, so the link/);
	});
	it("says nothing about a link when none was pasted", () => {
		expect(nativeSystemPrompt(base)).not.toMatch(/the link in this message/);
	});
});

// Every guest can run the native harness, so its prompt must carry the account facts too, or
// a model can tell a guest their chat will not survive signing in. Both prompts have to state the
// deployment's account facts. (CUR-2776)
describe("the native prompt states the account facts the persona prompt does (CUR-2776)", () => {
	const native = (account: { loginOffered: boolean; signedIn: boolean }) =>
		nativeSystemPrompt({ ...NATIVE_BASE, web: true, account });

	it("tells a guest's model that this conversation survives signing in", () => {
		expect(native(GUEST)).toContain("so yes, this conversation survives signing in");
	});

	it("tells a signed-in visitor's model that their conversations are saved to their account", () => {
		expect(native({ loginOffered: true, signedIn: true })).toContain(
			"their conversations are saved to their account"
		);
	});

	it("says sign-in is not offered where it is not, rather than promising an account", () => {
		expect(native({ loginOffered: false, signedIn: false })).toContain("Sign-in is not offered on this deployment");
	});

	// "saved to their account" read as "I can recall them", and a signed-in turn 1 summarized an
	// earlier exchange that was never shown to the model. (CUR-3303)
	it.each([
		["signed in", { loginOffered: true, signedIn: true }],
		["a guest", GUEST],
		["sign-in not offered", { loginOffered: false, signedIn: false }],
	])("tells the model it sees only this conversation when %s, so saved conversations are not recalled", (_, account) => {
		expect(native(account)).toContain("You see only the messages in this conversation");
		expect(native(account)).toContain("never claim to recall, quote or summarize an earlier conversation");
	});

	it("uses the same sentence as the persona prompt, so the two harnesses cannot drift apart", () => {
		expect(native(GUEST)).toContain(accountClause(GUEST));
		expect(buildPersonaPrompt("m", undefined, { account: GUEST })).toContain(accountClause(GUEST));
	});
});

// Asked how it compares with ChatGPT, the model said the app has no voice and no images
// while the composer offered the microphone and image attachments. The contract is that every
// prompt path states each feature the composer offers this turn, and says nothing about one it
// doesn't, so the model is never told a feature exists that the visitor cannot find. (CUR-3200)
describe("featuresClause (CUR-3200)", () => {
	const ALL = { dictation: true, textFiles: true, images: true, documents: true, readAloud: true };
	const NONE = { dictation: false, textFiles: false, images: false, documents: false, readAloud: false };

	it("names every feature the composer offers and forbids denying it", () => {
		const out = featuresClause(ALL);
		expect(out).toMatch(/microphone/);
		expect(out).toMatch(/images attached/);
		expect(out).toMatch(/PDF and Word documents/);
		expect(out).toMatch(/reading answers aloud/);
		expect(out).toMatch(/say it has no voice input/);
		// Search-grounded turns can call the app "text-only" from web pages about other chatbots.
		expect(out).toMatch(/not from search results/);
		expect(out).toMatch(/never call this app text-only/);
	});

	// With nothing attached, a model asked which of a person's files it can read can name files from nowhere. (CUR-4052)
	it("tells a turn that can take files it cannot see My files, and a turn that can't says nothing of it", () => {
		expect(featuresClause(ALL)).toContain(MY_FILES_FACT);
		expect(featuresClause({ ...NONE, noAttach: "sign-in" })).not.toContain(MY_FILES_FACT);
	});

	it("claims nothing the composer doesn't offer this turn (empty when nothing is on)", () => {
		expect(featuresClause(NONE)).toBe("");
		const voiceOnly = featuresClause({ ...NONE, dictation: true });
		expect(voiceOnly).toMatch(/microphone/);
		expect(voiceOnly).not.toMatch(/image|photo|PDF|aloud/i);
	});

	it("never denies an offered feature on either prompt path: persona, native, and guards-only", () => {
		const clause = featuresClause(ALL);
		expect(clause).toMatch(/say it has no voice input/);
		expect(buildPersonaPrompt("m", undefined, { features: ALL })).toContain(clause);
		expect(nativeSystemPrompt({ ...NATIVE_BASE, web: true, features: ALL })).toContain(clause);
		expect(guardsOnlyPrompt({ modelId: "m", today: "2026-10-01", account: GUEST, features: ALL })).toContain(
			clause
		);
	});

	it("leaves the features unsaid when the caller passes none (the tuning tools)", () => {
		expect(buildPersonaPrompt("m")).not.toMatch(/This app offers/);
		expect(nativeSystemPrompt({ ...NATIVE_BASE, web: true })).not.toMatch(/This app offers/);
	});});

// Asked "can I switch to a different one?", a model can say only one model is offered beside a
// model button listing several; asked "can you look things up on the web?", it can deny browsing and
// point at a "search icon in the top bar" that doesn't exist. Each fact names the real control. (CUR-3240)
describe("featuresClause model choice and web search (CUR-3240)", () => {
	const NONE = { dictation: false, textFiles: false, images: false, documents: false, readAloud: false };

	it("never denies model choice the model button offers, and names the models and the button", () => {
		const out = featuresClause({ ...NONE, otherModels: [{ name: "Apertus 1.5 70B", openness: "fully open" }] });
		expect(out).toMatch(/model button at the right of the message box/);
		expect(out).toMatch(/Apertus 1\.5 70B/);
		expect(out).toMatch(/never say this app offers only one model or that they can't switch/);
	});

	it("never denies web search while it is on, and points to the Tools menu instead of an invented button", () => {
		const out = featuresClause({ ...NONE, webSearch: "auto" });
		expect(out).toMatch(/Tools menu/);
		expect(out).toMatch(/searches the open web/);
		expect(out).toMatch(/never say you can't browse or search the web, and never point to any other search button/);
		expect(featuresClause({ ...NONE, webSearch: "always" })).toMatch(/for every message/);
		// Answers can offer live sports results, which search skips. CUR-2424:
		// today's prices, rates, weather and headlines do search, so the prompt must not rule them out. (CUR-3240)
		expect(out).toMatch(/no live feeds, so the score of a match in progress is out of reach; don't offer that/);
		expect(out).not.toMatch(/(prices|weather|news|headlines)[^.;]*out of reach/);
	});

	it("says a turned-off search is off this turn, and where to turn it back on, without claiming a search", () => {
		const out = featuresClause({ ...NONE, webSearch: "off" });
		expect(out).toMatch(/turned it off/);
		expect(out).not.toMatch(/searches the open web/);
		// An event-instance turn that headed its links "from open web search" had search off. (CUR-3665)
		expect(out).toMatch(/never say or imply that its sources or links came from a search/);
	});

	it("tells a turn whose search did not run that its sources are not search results (CUR-3665)", () => {
		const unsearched = featuresClause({ ...NONE, webSearch: "auto", searched: false });
		expect(unsearched).toMatch(/This turn ran no search/);
		expect(unsearched).toMatch(/never say or imply that its sources or links came from a search/);
		expect(unsearched).not.toMatch(/cites what it found/);
		// Search stays on for the next message, so the "never say you can't search" line still holds.
		expect(unsearched).toMatch(/never say you can't browse or search the web/);
		expect(featuresClause({ ...NONE, webSearch: "auto", searched: true })).toMatch(/cites what it found/);
		// Native turns search by tool mid-turn and pass no bit, so they get the rule for both outcomes.
		const native = featuresClause({ ...NONE, webSearch: "auto" });
		expect(native).toMatch(/an answer that searched cites what the search returned/);
		expect(native).toMatch(/called no search tool[^.]*never say or imply that its sources or links came from a search/);
		expect(resolveFeatureFacts({ id: "m" }, { webSearchMode: "auto", searched: false }).searched).toBe(false);
	});

	it("resolves no search claim for a turn that sent no mode (CUR-3293)", () => {
		const facts = resolveFeatureFacts({ id: "m" }, {});
		expect(facts.webSearch).toBeUndefined();
		expect(featuresClause(facts)).not.toMatch(/searches the open web/);
	});

	it("claims no model choice with one model and no search sentence without a mode", () => {
		expect(featuresClause({ ...NONE, otherModels: [] })).toBe("");
	});

	it("reaches the persona, native and guards-only prompts", () => {
		const facts = { ...NONE, otherModels: [{ name: "Apertus 1.5 70B", openness: "fully open" }], webSearch: "auto" as const };
		const clause = featuresClause(facts);
		expect(buildPersonaPrompt("m", undefined, { features: facts })).toContain(clause);
		expect(nativeSystemPrompt({ ...NATIVE_BASE, web: true, features: facts })).toContain(clause);
		expect(guardsOnlyPrompt({ modelId: "m", today: "2026-10-01", account: GUEST, features: facts })).toContain(clause);
	});
});

// An open-source builder's questions need the facts below: where private code lives, each
// model's own maker, each model's licence, the full picker count, what "contribute compute to Alpha"
// means, and the Personalization setting. (CUR-3889)
describe("facts a builder asks about (CUR-3889)", () => {
	const NONE = { dictation: false, textFiles: false, images: false, documents: false, readAloud: false };
	const facts = {
		...NONE,
		answering: { name: "Mistral Large 3", maker: "Mistral AI", openness: "open weights" },
		otherModels: [
			{ name: "Apertus 1.5 70B", maker: "the Swiss National AI Institute (SNAI)", openness: "fully open" },
			{ name: "ALIA 40B", maker: "the Barcelona Supercomputing Center (BSC)", openness: "open weights" },
			{ name: "Unknown 7B", openness: "open weights" },
		],
	};

	it("lists each model's maker and openness on a turn with no tools, with the count", () => {
		const out = featuresClause(facts);
		expect(out).toContain("ALIA 40B (made by the Barcelona Supercomputing Center (BSC), open weights)");
		expect(out).toContain("Apertus 1.5 70B (made by the Swiss National AI Institute (SNAI), fully open)");
		expect(out).toContain("Unknown 7B (open weights)");
		expect(out).toMatch(/That is 4 models, all open; when asked which there are, name all 4 and never give another number/);
		expect(out).toMatch(/Current AI runs this app and made none of these models/);
		expect(out).toMatch(/Never name a licence from memory or give any other link to a model/);
	});

	it("gives each offered model the badge's vetted card and none where there is no public card (CUR-3913)", () => {
		const listed = [
			{ id: "mistral-large-2512" },
			{ id: "swiss-ai/apertus-v1.5-70b" },
			{ id: "BSC-LT/ALIA-40b-instruct" },
			{ id: "speakleash/Bielik-11B-v3.0-Instruct" },
			{ id: "zai-org/GLM-5.2" },
		];
		const lane = laneFeatureFacts(NONE, "mistral-large-2512", listed);
		const cards = Object.fromEntries([lane.answering!, ...lane.otherModels!].map((m) => [m.name, m.card]));
		expect(cards["Mistral Large 3"]).toBe("https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512");
		expect(cards["GLM 5.2"]).toBe("https://huggingface.co/zai-org/GLM-5.2");
		expect(Object.values(cards).filter(Boolean)).toHaveLength(4);
		// ALIA's served instruct checkpoint answers 401 on Hugging Face, so it gets no link to copy.
		const alia = lane.otherModels!.find((m) => m.name.startsWith("ALIA"));
		expect(alia?.card).toBeUndefined();
		const out = featuresClause(lane);
		expect(out).toContain("model card https://huggingface.co/zai-org/GLM-5.2");
		expect(out).toMatch(/for one with no card listed, say it has no public card to link/);
	});

	// Licences must not contradict Large 3's, Bielik's and GLM's cards, and Small 4,
	// which the picker does not offer on www, must not get a made-up huggingface.co/mistralai/Mistral-Small-4 link.
	it("states each card's own licence beside it, and gives no link for a model the list leaves out (CUR-3913)", () => {
		const listed = [{ id: "mistral-large-2512" }, { id: "speakleash/Bielik-11B-v3.0-Instruct" }, { id: "zai-org/GLM-5.2" }, { id: "BSC-LT/ALIA-40b-instruct" }];
		const lane = laneFeatureFacts(NONE, "mistral-large-2512", listed);
		const licences = Object.fromEntries([lane.answering!, ...lane.otherModels!].map((m) => [m.name, m.licence]));
		expect(licences).toEqual({ "Mistral Large 3": "Apache 2.0", "Bielik 11B v3": "Apache 2.0", "GLM 5.2": "MIT", "ALIA 40B": undefined });
		const out = featuresClause(lane);
		expect(out).toContain("licence MIT, model card https://huggingface.co/zai-org/GLM-5.2)");
		expect(out).toMatch(/Asked about a model not in this list, say this app does not offer it and give no link or licence for it/);
	});

	it("lists makers and openness on a turn with search_catalog too, since Large 3 invented makers when sent to the tool", () => {
		const out = featuresClause({ ...facts, catalogTool: true });
		expect(out).toContain("Apertus 1.5 70B (made by the Swiss National AI Institute (SNAI), fully open)");
		expect(out).toMatch(/Those makers and openness are the facts; never credit a model to anyone else/);
		expect(out).toMatch(/For anything else about a model, call search_catalog/);
		expect(out).toMatch(/That is 4 models/);
		expect(out).toMatch(/Current AI runs this app and made none of these models/);
	});

	it("claims no 'all open' when a model's openness is not on record (Large 4 before its weights ship)", () => {
		const withLarge4 = { ...facts, otherModels: [...facts.otherModels, { name: "Mistral Large 4 (preview)", maker: "Mistral AI", openness: "" }] };
		const out = featuresClause(withLarge4);
		expect(out).toMatch(/That is 5 models; when asked which there are, name all 5/);
		expect(out).not.toMatch(/all open/);
		expect(out).toContain("Mistral Large 4 (preview) (made by Mistral AI, openness not on record)");
		expect(out).toMatch(/whose openness is not on record, say so rather than call it open or closed/);
		expect(featuresClause({ ...withLarge4, catalogTool: true })).not.toMatch(/all open/);
	});

	it("lists the answering model first and marks it, so the list holds every offered model (CUR-3895)", () => {
		const out = featuresClause(facts);
		expect(out).toContain("for the next message: Mistral Large 3 (answering now, made by Mistral AI, open weights), Apertus 1.5 70B");
		expect(out.match(/answering now/g)).toHaveLength(1);
	});

	// "why use you instead of ChatGPT?" must not get "Apertus 11B" and the tools'
	// "code is open for inspection", and model cards must not be placed "in the model button".
	it("asks for each model's exact name and size, and puts no card in the model button", () => {
		const out = featuresClause(facts);
		expect(out).toMatch(/Name each model exactly as listed, size included, never a size from another model/);
		expect(out).toMatch(/The model button shows names only, so give a model card's link yourself/);
	});

	it("shows the ChatGPT comparison crediting open weights, with the app's code not public yet", () => {
		const shot = DEFAULT_PERSONA_TEMPLATE.split("\n").find((l) => l.includes("what makes me different"));
		expect(shot).toMatch(/my weights are open to inspect, not that I'm more capable\. This app's own code is not public yet\./);
		expect(shot).not.toMatch(/open and inspectable/);
	});

	it("states no count when the answering model is unknown, rather than one that leaves it out", () => {
		expect(featuresClause({ ...facts, answering: undefined })).not.toMatch(/models, all open/);
	});

	it("says Alpha's code is not public, points compute to the Contribute page's form, and where Personalization is", () => {
		expect(ABOUT_ALPHA_FACT).toMatch(/code is not public yet/);
		expect(ABOUT_ALPHA_FACT).toMatch(/never give a link to its code or docs/);
		expect(ABOUT_ALPHA_FACT).toMatch(/can't be plugged into Alpha directly yet/);
		expect(ABOUT_ALPHA_FACT).toMatch(/"Become a contributor" form on the AI Potluck Contribute page \(aipotluck\.org\/contribute\)/);
		expect(ABOUT_ALPHA_FACT).toMatch(/Settings → Contribute/);
		expect(ABOUT_ALPHA_FACT).toMatch(/Settings → Personalization/);
		expect(ABOUT_ALPHA_FACT, "a compute answer linked aipotluck.org/catalog, a 404").toMatch(/Link no other aipotluck\.org page than the ones these instructions name/);
	});

	it("reaches the persona, native and guards-only prompts with the model facts", () => {
		const clause = featuresClause(facts);
		for (const prompt of [
			buildPersonaPrompt("m", undefined, { features: facts }),
			nativeSystemPrompt({ ...NATIVE_BASE, web: true, features: facts }),
			guardsOnlyPrompt({ modelId: "m", today: "2026-10-01", account: GUEST, features: facts }),
		]) {
			expect(prompt).toContain(clause);
			expect(prompt).toContain(ABOUT_ALPHA_FACT);
		}
	});
});

// With read aloud off, every visitor's default, "can you read that out loud?" sent the visitor
// to a speaker icon or Listen button on the message; the Tools menu is the only read-aloud control. (CUR-3254)
describe("featuresClause read aloud (CUR-3254)", () => {
	const NONE = { dictation: false, textFiles: false, images: false, documents: false, readAloud: false };

	it("with read aloud off, says to turn it on in the Tools menu and never points to a button on the message", () => {
		const out = featuresClause({ ...NONE, readAloud: true, readAloudMode: "off" });
		expect(out).toMatch(/Read aloud is set in the Tools menu/);
		expect(out).toMatch(/turn it on there and then ask again/);
		expect(out).toMatch(/Never point to a speaker icon, Listen button or play button/);
		expect(out).not.toMatch(/plays under/);
	});

	it("on auto, says asking makes the audio; on always, says every answer is read", () => {
		expect(featuresClause({ ...NONE, readAloud: true, readAloudMode: "auto" })).toMatch(/asking for an answer read aloud makes its audio/);
		expect(featuresClause({ ...NONE, readAloud: true, readAloudMode: "always" })).toMatch(/this answer is read aloud/);
	});

	it("says nothing about read aloud where it is not offered, even with a mode", () => {
		expect(featuresClause({ ...NONE, readAloudMode: "auto" })).toBe("");
	});
});

// A model can say "I don't track or measure how long you've been chatting" while the session
// meter (time and energy) sits in the header. The meter is in every chat header, so every prompt path
// that states the app's features states the meter too, even when the composer offers nothing else. (CUR-3209)
describe("SESSION_METER_FACT (CUR-3209)", () => {
	const NONE = { dictation: false, textFiles: false, images: false, documents: false, readAloud: false };

	it("names the meter, says the numbers stay in the browser, and forbids denying it", () => {
		expect(SESSION_METER_FACT).toMatch(/session meter/);
		expect(SESSION_METER_FACT).toMatch(/minutes/);
		expect(SESSION_METER_FACT).toMatch(/energy/);
		expect(SESSION_METER_FACT).toMatch(/not sent to Current AI/);
		expect(SESSION_METER_FACT).toMatch(/never say the app doesn't track or show them/);
	});

	it("reaches the persona, native and guards-only prompts, even with every composer feature off", () => {
		expect(buildPersonaPrompt("m", undefined, { features: NONE })).toContain(SESSION_METER_FACT);
		expect(nativeSystemPrompt({ ...NATIVE_BASE, web: true, features: NONE })).toContain(
			SESSION_METER_FACT
		);
		expect(guardsOnlyPrompt({ modelId: "m", today: "2026-10-01", account: GUEST, features: NONE })).toContain(
			SESSION_METER_FACT
		);
	});

	it("stays out when the caller passes no features (the tuning tools)", () => {
		expect(buildPersonaPrompt("m")).not.toContain(SESSION_METER_FACT);
		expect(nativeSystemPrompt({ ...NATIVE_BASE, web: true })).not.toContain(SESSION_METER_FACT);
	});
});

// The native path (the default model) must name who runs the app, as the persona template does, and
// keep the host as the one that runs the model (CUR-2135).
describe("native prompt names the operator (CUR-3200 walk)", () => {
	it("says Current AI runs the app and does not run the model", () => {
		const out = nativeSystemPrompt({ ...NATIVE_BASE, web: true });
		expect(out).toMatch(/a chat app that Current AI runs/);
		expect(out).toMatch(/Current AI did not build you and does not run you/);
	});
});

// Asked how to export a conversation, a model must not name a "three-dot menu (⋮)"
// and an "Export" option, neither of which exists. The title menu's "Export as Markdown" is shown to
// every visitor, so every prompt path that states the app's features names it.
describe("CONVERSATION_EXPORT_FACT", () => {
	const NONE = { dictation: false, textFiles: false, images: false, documents: false, readAloud: false };

	it("names the real control and label, and forbids naming a three-dot menu", () => {
		expect(CONVERSATION_EXPORT_FACT).toMatch(/title at the top of the chat/);
		expect(CONVERSATION_EXPORT_FACT).toContain('"Export as Markdown"');
		expect(CONVERSATION_EXPORT_FACT).toMatch(/never name a three-dot menu/);
	});

	it("reaches the persona, native and guards-only prompts, even with every composer feature off", () => {
		expect(buildPersonaPrompt("m", undefined, { features: NONE })).toContain(CONVERSATION_EXPORT_FACT);
		expect(nativeSystemPrompt({ ...NATIVE_BASE, web: true, features: NONE })).toContain(
			CONVERSATION_EXPORT_FACT
		);
		expect(guardsOnlyPrompt({ modelId: "m", today: "2026-10-01", account: GUEST, features: NONE })).toContain(
			CONVERSATION_EXPORT_FACT
		);
	});

	it("stays out when the caller passes no features (the tuning tools)", () => {
		expect(buildPersonaPrompt("m")).not.toContain(CONVERSATION_EXPORT_FACT);
	});
});

// signed-in visitors must not be sent to "Forget everything…" to delete their account
// (it keeps the account), nor told of an invented "Export my data" button that emails a link. (CUR-3242)
describe("accountClause data controls (CUR-3242)", () => {
	const SIGNED_IN = { loginOffered: true, signedIn: true };

	it("sends a signed-in visitor to Account → Delete account, not to Forget everything", () => {
		const s = accountClause(SIGNED_IN);
		expect(s).toMatch(/Settings → Account and press "Delete account"/);
		expect(s).toMatch(/"Forget everything…" .* but keeps the account/);
	});

	it("offers Download your data only when the data-export gate is on", () => {
		expect(accountClause({ ...SIGNED_IN, dataExport: true })).toMatch(/Settings → Account and press "Download your data" \(it is not on Data & privacy\)/);
		expect(accountClause({ ...GUEST, dataExport: true })).toMatch(/Settings → Account → "Download your data" \(not on Data & privacy\)/);
		const off = accountClause({ ...SIGNED_IN, dataExport: false });
		expect(off).not.toContain("Download your data");
		expect(off).toMatch(/no download-all-data option/);
	});

	it("tells a guest that deleting an account needs sign-in, and where the control is once they have", () => {
		const s = accountClause(GUEST);
		expect(s).toMatch(/needs signing in first; once signed in, it is Settings → Account → "Delete account"/);
		expect(s).toContain('"Export as Markdown"');
	});

	it("never tells a visitor to sign in on a deployment that offers no sign-in", () => {
		const s = accountClause({ loginOffered: false, signedIn: false });
		expect(s).not.toMatch(/needs signing in/);
		expect(s).toMatch(/no accounts to delete and no download-all-data option/);
	});

	it("tells a visitor with no account the same retention the composer notice shows, and an account holder theirs is kept (CUR-3429)", () => {
		const days = new RegExp(`deleted automatically after ${RETENTION_DAYS} days of inactivity`);
		expect(accountClause(GUEST)).toMatch(days);
		expect(accountClause({ loginOffered: false, signedIn: false })).toMatch(days);
		expect(accountClause(GUEST)).toMatch(/never say they are kept until the visitor deletes them/);
		const signedIn = accountClause(SIGNED_IN);
		expect(signedIn).not.toMatch(days);
		expect(signedIn).toMatch(/kept until they delete them or the account/);
	});

	it("tells guests and account holders that another sign-in method on the same address joins or is refused, wherever sign-in is offered (CUR-3157)", () => {
		for (const f of [GUEST, SIGNED_IN]) {
			expect(accountClause(f)).toMatch(/an email code opens the account that already uses that address/);
			expect(accountClause(f)).toMatch(/"An account with this email already exists\."/);
		}
		expect(accountClause({ loginOffered: false, signedIn: false })).not.toMatch(/email code opens/);
	});

	it("forbids invented controls in every state", () => {
		for (const f of [GUEST, SIGNED_IN, { loginOffered: false, signedIn: false }]) {
			expect(accountClause(f)).toMatch(/never invent another button, label, menu or emailed link/);
		}
	});
});
