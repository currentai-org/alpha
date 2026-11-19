/**
 * The model request a switched-language turn sends, driven through the real textGenerationWithoutTitle
 * into a recording endpoint, on answerPreferences.turn.spec.ts's harness. After two Spanish turns,
 * Apertus 1.5 70B can answer "Now in English please" in Spanish. For a model whose profile asks for
 * it, the request names the latest message's language after the fence when it reads as a different
 * language from the answer before it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "bson";
import { resolveHarness } from "../harness";
import type { AnswerPreferences } from "$lib/chat/answerPreferences";
import { ANSWER_DEFAULTS } from "$lib/chat/answerPreferences";

vi.mock("../mcp", async (importOriginal) => ({
	...(await importOriginal<typeof import("../mcp")>()),
	mcpEnabled: () => false,
}));
vi.mock("$lib/chat/server/flags", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/flags")>()),
	ensureFlagsPolled: async () => {},
}));
vi.mock("../localitySemantic", () => ({ isLocalityQuerySemantic: async () => false }));
vi.mock("./worldModel", async (importOriginal) => ({
	...(await importOriginal<typeof import("./worldModel")>()),
	WORLD_MODEL_PREPASS: false,
	maybeWorldModelNote: async () => null,
}));
vi.mock("../languageFallbackGate", async (importOriginal) => ({
	...(await importOriginal<typeof import("../languageFallbackGate")>()),
	lowResourcePerModelEnabled: () => false,
}));
let answer: AnswerPreferences | undefined;
let replyInUserLanguage = true;
vi.mock("./turnPreferences", () => ({
	resolveTurnPreferences: async () => ({ replyInUserLanguage, answer }),
	effectivePreprompt: (preprompt: string | undefined) => preprompt,
}));
vi.mock("../tuning", () => ({ getTuning: async () => ({ decoding: {} }) }));
vi.mock("../endpoints/preprocessMessages", () => ({
	preprocessMessages: async (messages: unknown) => messages,
}));

import { textGenerationWithoutTitle } from "./index";
import { fixedLanguageSentence } from "./answerClauses";
import type { TextGenerationContext } from "./types";

const APERTUS = "swiss-ai/apertus-v1.5-70b";
const LARGE_3 = "mistral-large-2512";
const ENGLISH_NOTE = "The person wrote in English. Write your whole answer in English.";

const SPANISH_HISTORY = [
	{ from: "user" as const, content: "¿Puedes darme tres consejos sencillos para ahorrar energía en casa?" },
	{
		from: "assistant" as const,
		content:
			"1. Apaga las luces y desconecta los electrodomésticos cuando no los uses.\n2. Baja la calefacción un grado.\n3. Lava la ropa con agua fría.",
	},
	{ from: "user" as const, content: "¿Cuál de estos tres consejos ahorra más dinero? Explícalo en dos frases." },
	{
		from: "assistant" as const,
		content:
			"Apagar las luces y desconectar los electrodomésticos es lo que más ahorra. La calefacción es el mayor gasto de la casa, así que bajarla un grado también ayuda mucho.",
	},
];
const SWITCH = "Thanks. Now in English please: which one is easiest to start today?";

async function userTurnFor(opts: {
	modelId: string;
	text: string;
	history: { from: "user" | "assistant"; content: string }[];
}): Promise<{ userTurn: string; answerLanguages: string[] }> {
	let userTurn: string | undefined;
	const endpoint = async (params: Record<string, unknown>) => {
		const messages = params.messages as { from: string; content?: string }[];
		userTurn = messages.findLast((m) => m.from === "user")?.content ?? "";
		return (async function* () {
			yield { token: { id: 0, text: "ok", logprob: 0, special: false }, generated_text: null, details: null };
			yield { token: { id: 1, text: "", logprob: 0, special: true }, generated_text: "ok", details: null };
		})();
	};
	const ctx = {
		model: { id: opts.modelId, name: opts.modelId, supportsTools: true, parameters: {} },
		endpoint,
		conv: { _id: new ObjectId("000000000000000000000001"), title: "t", messages: [], preprompt: "" },
		messages: [
			...opts.history.map((m, i) => ({ id: `h${i}`, ...m, createdAt: new Date(), updatedAt: new Date() })),
			{ id: "m1", from: "user", content: opts.text, createdAt: new Date(), updatedAt: new Date() },
		],
		promptedAt: new Date(),
		ip: "127.0.0.1",
		speakMode: "auto",
		webSearchMode: "off",
		locals: undefined,
		abortController: new AbortController(),
		harness: resolveHarness({ id: opts.modelId, supportsTools: true }),
	} as unknown as TextGenerationContext;
	const answerLanguages: string[] = [];
	for await (const u of textGenerationWithoutTitle(ctx, new AbortController())) {
		const lang = (u as { answerLanguage?: string }).answerLanguage;
		if (lang) answerLanguages.push(lang);
	}
	if (userTurn === undefined) throw new Error("the turn never reached the endpoint");
	return { userTurn, answerLanguages };
}

beforeAll(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
});
afterAll(() => {
	vi.useRealTimers();
});

describe("a switched-language turn on Apertus names the message's language after the fence", () => {
	it("after two Spanish answers, an English message's turn ends by asking for English", async () => {
		answer = undefined;
		replyInUserLanguage = true;
		const got = await userTurnFor({ modelId: APERTUS, text: SWITCH, history: SPANISH_HISTORY });
		const fenceClose = got.userTurn.lastIndexOf("</Q_");
		expect(fenceClose).toBeGreaterThan(-1);
		expect(got.userTurn.slice(fenceClose)).toContain(ENGLISH_NOTE);
		expect(got.answerLanguages).toContain("eng");
	});

	it("a Spanish follow-up after Spanish answers names nothing, so an unswitched turn is unchanged", async () => {
		answer = undefined;
		replyInUserLanguage = true;
		const got = await userTurnFor({ modelId: APERTUS, text: "¿Y cuál es el más fácil de empezar hoy?", history: SPANISH_HISTORY });
		expect(got.userTurn).not.toContain("The person wrote in");
		expect(got.answerLanguages).toEqual([]);
	});

	it("a model whose profile doesn't ask for it names nothing", async () => {
		answer = undefined;
		replyInUserLanguage = true;
		const got = await userTurnFor({ modelId: LARGE_3, text: SWITCH, history: SPANISH_HISTORY });
		expect(got.userTurn).not.toContain(ENGLISH_NOTE);
	});

	it("a fixed answer language wins: the turn names the fixed language, not the message's", async () => {
		answer = { ...ANSWER_DEFAULTS, answerLanguage: "fr" };
		replyInUserLanguage = true;
		const got = await userTurnFor({ modelId: APERTUS, text: SWITCH, history: SPANISH_HISTORY });
		expect(got.userTurn).not.toContain(ENGLISH_NOTE);
		expect(got.userTurn).toContain(fixedLanguageSentence("French"));
		answer = undefined;
	});

	it("with the reply-language rule off for the account, nothing is named", async () => {
		answer = undefined;
		replyInUserLanguage = false;
		const got = await userTurnFor({ modelId: APERTUS, text: SWITCH, history: SPANISH_HISTORY });
		expect(got.userTurn).not.toContain(ENGLISH_NOTE);
		replyInUserLanguage = true;
	});
});
