import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EndpointMessage } from "../endpoints/types";
import { ANSWER_DEFAULTS, type AnswerPreferences } from "$lib/chat/answerPreferences";

// Where each answer setting lands on each prompt path, and that the defaults leave every
// path's text as it was. The fenced user turn is read through the real hardenLastUserTurn; the
// guards-only and native system prompts through their real renderers. (CUR-3929)

let lengthFirst = false;
vi.mock("./lengthFirstBrevityGate", () => ({ lengthFirstBrevityEnabled: () => lengthFirst }));
vi.mock("$lib/chat/server/flags", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/flags")>()),
	ensureFlagsPolled: async () => {},
}));
vi.mock("../localitySemantic", () => ({ isLocalityQuerySemantic: async () => false }));

const { hardenLastUserTurn } = await import("./grounding");
const { guardsOnlyPrompt, nativeSystemPrompt } = await import("./native");
const {
	answerDigestFor,
	answerShapeFor,
	answerVoiceFor,
	DIGEST_RULES,
	EMOJIS_HELPFUL_CLAUSE,
	fixedLanguageSentence,
	FORMAT_SENTENCES,
	LENGTH_SENTENCES,
	NO_SUGGESTIONS_SENTENCE,
	PLAIN_LANGUAGE_CLAUSE,
	toneClauseFor,
	voiceExtrasFor,
} = await import("./answerClauses");

const BULLETS_RULE = "Put each list item and any section label on its own line, and prefer plain bullet points over numbered sections.";

const SAME_LANGUAGE_RULE = "Write your ENTIRE reply in the same language as the message inside the markers above";
const BREVITY_DEFAULT = "Answer concisely by default: a few sentences or a short list (at most ~5 items), not a long essay.";
const BREVITY_LENGTH_FIRST = "When your message asks for a specific length or a long document — a guide, report, policy, or plan — write it at that length, in full. Otherwise, answer concisely";

async function fencedTurn(answer?: AnswerPreferences, languageRule = true): Promise<string> {
	const messages: EndpointMessage[] = [{ from: "user", content: "How does VAT work?" }];
	await hardenLastUserTurn(messages, undefined, languageRule, undefined, undefined, false, false, answer);
	// The fence name is random per call; two turns compare on everything else.
	return (messages[0].content ?? "").replace(/Q_[0-9a-f]{8}/g, "Q_FENCE");
}

beforeEach(() => {
	lengthFirst = false;
});

describe("the fenced user turn (guardFor) with answer preferences", () => {
	it("is byte-identical on the defaults to the turn built with no preferences, in both brevity variants", async () => {
		expect(await fencedTurn(ANSWER_DEFAULTS)).toBe(await fencedTurn(undefined));
		expect(await fencedTurn(ANSWER_DEFAULTS)).toContain(BREVITY_DEFAULT);
		lengthFirst = true;
		expect(await fencedTurn(ANSWER_DEFAULTS)).toBe(await fencedTurn(undefined));
		expect(await fencedTurn(ANSWER_DEFAULTS)).toContain(BREVITY_LENGTH_FIRST);
	});

	it("short replaces the brevity sentence, in both variants", async () => {
		for (const flag of [false, true]) {
			lengthFirst = flag;
			const turn = await fencedTurn({ ...ANSWER_DEFAULTS, answerLength: "short" });
			expect(turn).toContain(LENGTH_SENTENCES.short);
			expect(turn).not.toContain(BREVITY_DEFAULT);
			expect(turn).not.toContain(BREVITY_LENGTH_FIRST);
		}
	});

	it("detailed replaces the brevity sentence", async () => {
		const turn = await fencedTurn({ ...ANSWER_DEFAULTS, answerLength: "detailed" });
		expect(turn).toContain(LENGTH_SENTENCES.detailed);
		expect(turn).not.toContain(BREVITY_DEFAULT);
	});

	it("a set length drops the project-context preamble's own sentence cap, and the default keeps it", async () => {
		const CAP = "Answer in at most 3–4 short sentences.";
		const project = async (answer: AnswerPreferences) => {
			const messages: EndpointMessage[] = [{ from: "user", content: "What is AI Potluck?" }];
			await hardenLastUserTurn(messages, undefined, true, undefined, undefined, false, false, answer);
			return messages[0].content ?? "";
		};
		expect(await project(ANSWER_DEFAULTS)).toContain(CAP);
		for (const answerLength of ["short", "detailed"] as const) {
			const turn = await project({ ...ANSWER_DEFAULTS, answerLength });
			expect(turn).not.toContain(CAP);
			expect(turn).toContain(LENGTH_SENTENCES[answerLength]);
		}
	});

	it("suggestions off adds its sentence, and on adds nothing", async () => {
		expect(await fencedTurn({ ...ANSWER_DEFAULTS, suggestions: false })).toContain(NO_SUGGESTIONS_SENTENCE);
		expect(await fencedTurn(ANSWER_DEFAULTS)).not.toContain(NO_SUGGESTIONS_SENTENCE);
	});

	it("a fixed language replaces the same-language rule, whether or not that rule is on", async () => {
		const pt = { ...ANSWER_DEFAULTS, answerLanguage: "pt" as const };
		for (const languageRule of [true, false]) {
			const turn = await fencedTurn(pt, languageRule);
			expect(turn).toContain(fixedLanguageSentence("Portuguese"));
			expect(turn).not.toContain(SAME_LANGUAGE_RULE);
		}
		expect(await fencedTurn(ANSWER_DEFAULTS, true)).toContain(SAME_LANGUAGE_RULE);
		expect(await fencedTurn(ANSWER_DEFAULTS, false)).not.toContain(SAME_LANGUAGE_RULE);
	});

	it("tone and plain language ride the fenced turn as sentences, and the defaults add nothing", async () => {
		const turn = await fencedTurn({ ...ANSWER_DEFAULTS, tone: "plain", plainLanguage: true });
		expect(turn).toContain(`Your tone is ${toneClauseFor("plain")}.`);
		expect(turn).toContain(PLAIN_LANGUAGE_CLAUSE);
		expect(await fencedTurn({ ...ANSWER_DEFAULTS, tone: "formal" })).toContain(`Your tone is ${toneClauseFor("formal")}.`);
		const neutral = await fencedTurn(ANSWER_DEFAULTS);
		expect(neutral).not.toContain("Your tone is");
		expect(neutral).not.toContain(PLAIN_LANGUAGE_CLAUSE);
	});

	// CUR-549
	it("auto keeps today's bullets rule; prose and bullets replace it", async () => {
		expect(await fencedTurn(ANSWER_DEFAULTS)).toContain(BULLETS_RULE);
		for (const answerFormat of ["prose", "bullets"] as const) {
			const turn = await fencedTurn({ ...ANSWER_DEFAULTS, answerFormat });
			expect(turn).toContain(FORMAT_SENTENCES[answerFormat]);
			expect(turn).not.toContain(BULLETS_RULE);
		}
	});

	it("emojis and the receipt do not ride the fenced turn", async () => {
		const turn = await fencedTurn({ ...ANSWER_DEFAULTS, emojis: "helpful", showServing: false });
		expect(turn).toBe(await fencedTurn(ANSWER_DEFAULTS));
	});
});

describe("answerShapeFor and answerVoiceFor", () => {
	it("are empty on the defaults", () => {
		expect(answerShapeFor(ANSWER_DEFAULTS)).toEqual([]);
		expect(answerVoiceFor(ANSWER_DEFAULTS)).toEqual([]);
	});

	it("name each set shape, in a fixed order", () => {
		expect(answerShapeFor({ ...ANSWER_DEFAULTS, answerLength: "short", suggestions: false, answerLanguage: "de" })).toEqual([
			LENGTH_SENTENCES.short,
			NO_SUGGESTIONS_SENTENCE,
			fixedLanguageSentence("German"),
		]);
		expect(
			answerShapeFor({ ...ANSWER_DEFAULTS, answerLength: "short", suggestions: false, answerFormat: "prose", answerLanguage: "de" })
		).toEqual([LENGTH_SENTENCES.short, NO_SUGGESTIONS_SENTENCE, FORMAT_SENTENCES.prose, fixedLanguageSentence("German")]);
	});

	it("the voice extras are plain language, emojis, in that order, and the receipt adds none (CUR-549)", () => {
		expect(voiceExtrasFor({ ...ANSWER_DEFAULTS, plainLanguage: true, emojis: "helpful" })).toEqual([
			PLAIN_LANGUAGE_CLAUSE,
			EMOJIS_HELPFUL_CLAUSE,
		]);
		expect(voiceExtrasFor({ ...ANSWER_DEFAULTS, emojis: "never", showServing: false })).toEqual([]);
		expect(answerVoiceFor({ ...ANSWER_DEFAULTS, tone: "formal", emojis: "helpful" })).toEqual([
			`Your tone is ${toneClauseFor("formal")}.`,
			EMOJIS_HELPFUL_CLAUSE,
		]);
	});

	it("say the tone as a sentence and the plain-language clause", () => {
		expect(answerVoiceFor({ ...ANSWER_DEFAULTS, tone: "formal", plainLanguage: true })).toEqual([
			`Your tone is ${toneClauseFor("formal")}.`,
			PLAIN_LANGUAGE_CLAUSE,
		]);
		expect(answerVoiceFor({ ...ANSWER_DEFAULTS, tone: "plain" })).toEqual([`Your tone is ${toneClauseFor("plain")}.`]);
	});
});

const BASE = { modelId: "mistral-large-2512", today: "2026-10-13", account: { loginOffered: true, signedIn: false } };

describe("the guards-only system prompt (scaffolded minimal) with answer preferences", () => {
	it("is byte-identical on the defaults and without an answer", () => {
		expect(guardsOnlyPrompt({ ...BASE, answer: ANSWER_DEFAULTS })).toBe(guardsOnlyPrompt(BASE));
	});

	it("carries the voice in the system role and leaves the shape to the fenced turn", () => {
		const out = guardsOnlyPrompt({ ...BASE, answer: { ...ANSWER_DEFAULTS, tone: "plain", answerLength: "short" } });
		expect(out).toContain(`Your tone is ${toneClauseFor("plain")}.`);
		expect(out).not.toContain(LENGTH_SENTENCES.short);
	});
});

describe("the native system prompt with answer preferences", () => {
	const native = { ...BASE, fence: "Q_x", web: false };

	it("is byte-identical on the defaults and without an answer", () => {
		expect(nativeSystemPrompt({ ...native, answer: ANSWER_DEFAULTS })).toBe(nativeSystemPrompt(native));
	});

	it("carries both the voice and the shape in the system role, since its user turn is the fence alone", () => {
		const out = nativeSystemPrompt({
			...native,
			answer: { ...ANSWER_DEFAULTS, tone: "formal", answerLength: "detailed", suggestions: false, answerLanguage: "fr" },
		});
		expect(out).toContain(`Your tone is ${toneClauseFor("formal")}.`);
		expect(out).toContain(LENGTH_SENTENCES.detailed);
		expect(out).toContain(NO_SUGGESTIONS_SENTENCE);
		expect(out).toContain(fixedLanguageSentence("French"));
	});

	it("carries the format as shape and emojis as voice (CUR-549)", () => {
		const out = nativeSystemPrompt({
			...native,
			answer: { ...ANSWER_DEFAULTS, answerFormat: "bullets", emojis: "helpful", showServing: false },
		});
		expect(out).toContain(FORMAT_SENTENCES.bullets);
		expect(out).toContain(EMOJIS_HELPFUL_CLAUSE);
		// The receipt is the page's: nothing in the prompt changes with it.
		expect(nativeSystemPrompt({ ...native, answer: { ...ANSWER_DEFAULTS, showServing: false } })).toBe(nativeSystemPrompt(native));
	});
});

// Plan 4.9.3 and 4.9.5: the digest is the rules of the set values, in a fixed order, one per line.
describe("answerDigestFor", () => {
	const PLAIN_TONE = `Write this answer the way a friendly colleague chats: warm, relaxed and personal, not flat like a reference page. Use contractions ("it's", "you'll"), speak to the person as "you", use everyday words, and add a friendly touch. Do not use formal phrases such as "it is important to note" or "in summary".`;
	const PROSE = `Write this answer as prose: full sentences in paragraphs, with no bullet points, no numbered list and no headings. When the answer has steps or several items, describe them in connected sentences instead of a list. When the message asks for a list, a table or a document with sections, give that shape.`;
	const DETAILED = `Write a full answer: cover each main point, explain the reasoning behind it, and name the main cases or exceptions that change the answer. When you answer in paragraphs, write four or more. When the answer is a set of items, such as a packing list, give a full list and explain the items that need it. Do not add an introduction, a summary or repeated points. When the message asks for a single fact, give only that fact, in one sentence. When it asks for a specific length or a document, write it in full at that length, and do not go past that length. Use what the person told you earlier in this conversation.`;
	const BULLETS = `Write this answer as a bulleted list: one point per line, each line starting with "- ", and no paragraphs of prose. You may open with one short sentence. When the message asks for a single sentence, a message to send or a document to use as it is, write that text instead.`;
	const EMOJIS = `Add one or two emojis to this answer where they carry meaning or warmth, such as beside a key point. A tax, legal or technical explanation gets them too, and a closing legal or safety note does not make the answer formal: put the emojis above that note, never in or after it. Use no emoji at all, not even in a sign-off, when the message asks for a document, a draft, a guide or code, when the answer is long (it has headings or runs past about 400 words), or when a formal register is asked for. Never use more than three.`;

	it("adds no text on the defaults", () => {
		expect(answerDigestFor(ANSWER_DEFAULTS)).toBeUndefined();
	});

	it("gives each set value exactly its own rule", () => {
		expect(answerDigestFor({ ...ANSWER_DEFAULTS, tone: "formal" })).toBe(DIGEST_RULES.formal);
		expect(answerDigestFor({ ...ANSWER_DEFAULTS, tone: "plain" })).toBe(PLAIN_TONE);
		expect(answerDigestFor({ ...ANSWER_DEFAULTS, plainLanguage: true })).toBe(DIGEST_RULES.plainLanguage);
		expect(answerDigestFor({ ...ANSWER_DEFAULTS, answerLength: "short" })).toBe(DIGEST_RULES.short);
		expect(answerDigestFor({ ...ANSWER_DEFAULTS, suggestions: false })).toBe(DIGEST_RULES.noSuggestions);
	});

	// A feature list alone can leave the answer speaking to the reader ("our eyes", "you may
	// register"), so the formal rule names the impersonal voice and the pronouns it replaces, plus the
	// recall sentence of the short rule. (CUR-4287)
	it("asks formal for an impersonal voice that replaces you, we and our, and keeps what the person said earlier", () => {
		const rule = answerDigestFor({ ...ANSWER_DEFAULTS, tone: "formal" }) ?? "";
		expect(rule).toMatch(/\bimpersonal\b/);
		for (const pronoun of ['"you"', '"we"', '"our"']) expect(rule, pronoun).toContain(pronoun);
		expect(rule).toMatch(/no contractions/);
		expect(rule).toMatch(/no exclamation marks/);
		// Without this sentence the impersonal voice broke recall ("The name provided ... cannot be recalled.").
		expect(rule).toMatch(/what the person told you earlier/);
	});

	// The rule's exact words, typed out so a changed rule turns this red. (CUR-4288)
	it("format prose and format bullets each carry their own measured rule, and auto carries none", () => {
		expect(answerDigestFor({ ...ANSWER_DEFAULTS, answerFormat: "prose" })).toBe(PROSE);
		expect(answerDigestFor({ ...ANSWER_DEFAULTS, answerFormat: "bullets" })).toBe(BULLETS);
		expect(answerDigestFor({ ...ANSWER_DEFAULTS, answerFormat: "auto" })).toBeUndefined();
	});

	// The rule's exact words, typed out so a changed rule turns this red. (CUR-4288)
	it("length detailed carries its own measured rule in the length slot, and normal carries none", () => {
		expect(answerDigestFor({ ...ANSWER_DEFAULTS, answerLength: "detailed" })).toBe(DETAILED);
		expect(answerDigestFor({ ...ANSWER_DEFAULTS, answerLength: "normal" })).toBeUndefined();
		const all = { ...ANSWER_DEFAULTS, answerFormat: "prose", suggestions: false, answerLength: "detailed", tone: "formal" } as const;
		expect(answerDigestFor(all)).toBe([DIGEST_RULES.formal, DETAILED, DIGEST_RULES.noSuggestions, PROSE].join("\n"));
	});

	// The rule's exact words, typed out so a changed rule turns this red. (CUR-4288)
	it("emojis helpful carries its own measured rule, and never carries none", () => {
		expect(answerDigestFor({ ...ANSWER_DEFAULTS, emojis: "helpful" })).toBe(EMOJIS);
		expect(answerDigestFor({ ...ANSWER_DEFAULTS, emojis: "never" })).toBeUndefined();
	});

	it("gives no rule for neutral tone, normal length, suggestions on, plain language off, or a fixed language", () => {
		for (const set of [
			{ tone: "neutral" },
			{ answerLength: "normal" },
			{ suggestions: true },
			{ plainLanguage: false },
			{ answerLanguage: "pt" },
			{ selfReferenceAsPerson: true },
		] as const) {
			expect(answerDigestFor({ ...ANSWER_DEFAULTS, ...set }), JSON.stringify(set)).toBeUndefined();
		}
	});

	it("puts two or more rules in the fixed order, tone, plain language, length, suggestions, format, emojis, one per line", () => {
		const all = { ...ANSWER_DEFAULTS, emojis: "helpful", answerFormat: "bullets", suggestions: false, answerLength: "short", plainLanguage: true, tone: "plain" } as const;
		expect(answerDigestFor(all)).toBe(
			[DIGEST_RULES.plainTone, DIGEST_RULES.plainLanguage, DIGEST_RULES.short, DIGEST_RULES.noSuggestions, DIGEST_RULES.bullets, DIGEST_RULES.emojis].join("\n")
		);
	});

	it("leaves out only the omitted rules, and adds nothing when every set value is omitted", () => {
		const prefs = { ...ANSWER_DEFAULTS, tone: "formal", answerLength: "short", plainLanguage: true } as const;
		expect(answerDigestFor(prefs, new Set(["formal", "short"]))).toBe(DIGEST_RULES.plainLanguage);
		expect(answerDigestFor({ ...ANSWER_DEFAULTS, tone: "formal", answerLength: "short" }, new Set(["formal", "short"]))).toBeUndefined();
	});
});
