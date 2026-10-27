/**
 * Read-aloud picks its voice from the language of the answer (CUR-3151). French, Portuguese
 * and Spanish answers were read in the Space's one American English voice. Read-aloud now asks
 * Kokoro, through Hugging Face's router, for the answer's language's own voice (CUR-3989). The detector half runs the
 * real detectors on real sentences; the maybeRunMcpTool half checks the clip each answer gets.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { KOKORO_VOICES, readAloudVoice, voiceAccent, voiceForLanguage } from "./readAloudLanguage";
import { ObjectId } from "bson";

/** The conversation a read-aloud clip is sealed to; the speech route plays it only for its owner. */
const CONV = new ObjectId();
import { openSpeechClip, speakableText, synthesizeSpeech } from "./readAloudSpeech";

const { mockConfig } = vi.hoisted(() => ({ mockConfig: {} as Record<string, string | undefined> }));
vi.mock("$lib/chat/server/config", () => ({ config: mockConfig }));
vi.mock("$lib/chat/server/models", () => ({
	models: [],
	defaultModel: { id: "test-model", name: "test-model" },
	taskModel: { id: "test-model", name: "test-model" },
}));

const FR =
	"Un CDD est un contrat à durée déterminée, qui se termine à une date prévue. Un CDI est un contrat à durée indéterminée, sans date de fin.";
const PT =
	"O IRS é o imposto sobre o rendimento das pessoas singulares, e o IVA é o imposto sobre o valor acrescentado que se paga nas compras.";
const ES =
	"Para empadronarte en Barcelona necesitas tu documento de identidad, el contrato de alquiler y el formulario de solicitud firmado.";
const EN = "Open source belongs to everyone, and the weights of this model are published for anyone to use.";
const DE =
	"Brot wird aus Mehl, Wasser, Salz und Hefe gemacht. Der Teig wird geknetet, dann lässt man ihn gehen, und danach wird er im Ofen gebacken, bis die Kruste braun und knusprig ist.";
const YO = "Ẹ kú àárọ̀. Báwo ni ẹ ṣe wà? Mo fẹ́ mọ̀ nípa ìtàn ìlú Ìbàdàn àti àwọn ènìyàn rẹ̀.";

// A model's Yoruba answer. Its function words score Italian 0.51, so it is refused in Yoruba's name
// rather than read in an Italian voice, because franc's first pick can refuse it.
const YO_ANSWER = "Ẹ kú àárọ̀! Dáadáa, mo lè sọ fún ọ nípa ìtàn ìlú Ìbàdàn ní èdè Yorùbá.\n\nÌbàdàn jẹ́ ìlú ńlá àti àgbáyé ní gbéṣẹ́ gúúsù Nigeria. Ìtàn ìlú Ìbàdàn bẹ̀rẹ̀ ní àṣàlẹ̀ ìjọba Òyó̀, ní àkókò ìjọba aláàfin Ṣàngó, ẹni tí ó ṣe àṣẹ ní ìlú Òyó̀. Nígbà tí ìjọba Òyó̀ ń bẹ̀rẹ̀ sí wáyé, àwọn ọmọ Òyó̀ tí wọ́n ń ṣe àgbẹ̀ṣẹ́ ńlẹ̀ ńlọ sí àárín-àjò ṣe ùnṣẹ́ láti dá ìlú Ìbàdàn.\n\nNí ọdún 1829, **Lágẹ́lú** àti **Jágun**, àwọn ọmọ Òyó̀ àti àwọn ológun, wọ́n ṣe ìdílé sí ìhà ìgbẹ́kẹ́lẹ́ tí wọ́n ń pè ní \"Èbú-Òdàn\". Nígbà tí wọ́n dà ààwọn ìgbẹ́kẹ́lẹ́ wọ̀nyí jọ, wọ́n ṣe ìlú Ìbàdàn. \"Ìbàdàn\" jẹ́ orúkọ tí wọ́n fi ń pè ààyè náà, tí ó túmọ̀ sí \"ìlú tí ó wà ní ìbà ìdàńdún\" (ìbà = ààrò, ìdàńdún = ààyè tí ó rọ̀).\n\nÌbàdàn ńlá ní àṣìṣe àgbáyé nítorí àwọn ìjẹ́lú àti àwọn àṣọ̀àlàyé tí ó ṣẹlẹ̀ níbi. Ní ọdún 1840, ìlú Ìbàdàn di ìjọba aládùúgbò̩, tí ó ṣàkóso àwọn ìlú mẹ́wàáḿẹ́fà ní àárín-àjò. **Ọlúṣẹ́**, **Ọlúọ̀gbọ̀n**, àti **Báṣọ̀rún Ògúnmọ́lá** jẹ́ àwọn olórí àkọkò náà tí wọ́n ṣe ìdásílẹ̀ ìlú Ìbàdàn.\n\nNí ọdún 1893, ìjọba Bírítísì ṣàkóso ìlú Ìbàdàn lọ́wọ́ àwọn aláàfin Òyó̀, tí wọ́n sì ṣe ìdílé sí ìlú náà. Nígbà náà, Ìbàdàn di ìlú ńlá ní ìpínlẹ̀ Òyọ́, tí ó sì ń ṣe àṣẹ àgbáyé ní gbogbo orílẹ̀ ìwọ̀-oòrùn Nigeria.";

describe("readAloudVoice — the voice follows the language of the answer (CUR-3151)", () => {
	it.each([
		["French", FR, "fr"],
		["Portuguese", PT, "pt"],
		["Spanish", ES, "es"],
		["English", EN, "en"],
	])("reads a %s answer in that language's voice", async (_name, text, code) => {
		expect(await readAloudVoice(text)).toMatchObject({ ok: true, code });
	});

	it("refuses a Yoruba answer by name: there is no Yoruba voice, and it is never read in English", async () => {
		expect(await readAloudVoice(YO)).toEqual({ ok: false, tag: "yor", name: "Yoruba" });
	});

	it("refuses a full Yoruba answer whose function words look Italian, rather than reading it in Italian", async () => {
		expect(await readAloudVoice(speakableText(YO_ANSWER))).toEqual({ ok: false, tag: "yor", name: "Yoruba" });
	});

	it.each([
		["French", FR, "fr"],
		["Portuguese", PT, "pt"],
		["Spanish", ES, "es"],
		["English", EN, "en"],
	])("still reads a full-length %s answer in its own voice", async (_name, text, code) => {
		expect(await readAloudVoice(`${text} ${text} ${text}`)).toMatchObject({ ok: true, code });
	});
});

describe("readAloudVoice — a one-line answer takes its voice from the question when the answer alone can't tell", () => {
	// A one-line French or Portuguese answer must not be read in the
	// Spanish voice: their function words ("la", "de", "es") outvote franc on a short line.
	it.each([
		["French", "La capitale de la France est Paris.", "Quelle est la capitale de la France ? Réponds en une ligne.", "fr"],
		["Portuguese", "A capital de Portugal é Lisboa.", "Qual é a capital de Portugal? Responde numa linha.", "pt"],
		["Spanish", "La capital de España es Madrid.", "¿Cuál es la capital de España? Responde en una línea.", "es"],
	])("reads a one-line %s answer to a question in that language in its voice", async (_name, answer, question, code) => {
		expect(await readAloudVoice(answer, question)).toMatchObject({ ok: true, code });
	});

	// A one-word answer is read in the question's voice, not English: "Paris." has
	// nothing for any detector to go on.
	it.each([
		["French", "Paris.", "Quelle est la capitale de la France ? Réponds en une ligne.", "fr"],
		["Portuguese", "Lisboa.", "Qual é a capital de Portugal? Responde numa linha.", "pt"],
		["Spanish", "Madrid.", "¿Cuál es la capital de España? Responde en una línea.", "es"],
	])("reads a one-word %s answer in the question's voice", async (_name, answer, question, code) => {
		expect(await readAloudVoice(answer, question)).toMatchObject({ ok: true, code });
	});

	it("reads a one-word answer to an English question in English", async () => {
		expect(await readAloudVoice("Paris.", "What is the capital of France?")).toMatchObject({ ok: true, code: "en" });
	});

	it("keeps the answer's own language when the question is in one the answer doesn't look like", async () => {
		expect(await readAloudVoice("Bonjour ! Je vais très bien, merci.", "How do I say I am fine in French?")).toMatchObject({ ok: true, code: "fr" });
	});

	it("leaves a full-length answer to its own detection, whatever the question's language", async () => {
		expect(await readAloudVoice(`${FR} ${FR}`, "Explain CDD and CDI in French, please.")).toMatchObject({ ok: true, code: "fr" });
	});
});

describe("readAloudVoice — an answer with too few letters to detect is never refused", () => {
	// "Yes, 64.00 + 7.50 = 71.50." has three letters, and franc names them Central Atlas Tamazight, a
	// language with no voice. The answer must be read in English instead of being refused.
	const SUM = "Yes, 64.00 + 7.50 = 71.50.";
	const SUM_QUESTION = "Check: does 64.00 plus 7.50 equal 71.50?";

	it("reads a mostly-numeric English answer in English, not refused as a language with no voice", async () => {
		expect(await readAloudVoice(SUM, SUM_QUESTION)).toMatchObject({ ok: true, code: "en" });
	});

	it("reads it in English with no question and no browser language", async () => {
		expect(await readAloudVoice(SUM)).toMatchObject({ ok: true, code: "en" });
	});

	it("takes the browser's language when neither the answer nor the question can be placed", async () => {
		expect(await readAloudVoice("64 + 7,5 = 71,5", "64 + 7,5 ?", "fr")).toMatchObject({ ok: true, code: "fr" });
	});

	it("reads English when the browser's language has no voice, rather than refusing", async () => {
		expect(await readAloudVoice(SUM, undefined, "de")).toMatchObject({ ok: true, code: "en" });
	});

	it("still takes the question's language over the browser's when the question's words place it", async () => {
		expect(
			await readAloudVoice("Sí, 71,50.", "¿Cuál es la suma de 64,00 y 7,50? Responde en una línea.", "en")
		).toMatchObject({ ok: true, code: "es" });
	});

	it("refuses in German's name when a German question gets a short answer, rather than reading it in English unasked (CUR-3989)", async () => {
		for (const browser of [undefined, "de", "en"]) {
			expect(await readAloudVoice("Ja, 4.", "Ist das richtig? Antworte bitte kurz.", browser)).toMatchObject({ ok: false });
		}
	});

	it("takes a region-tagged browser language by its primary subtag", async () => {
		expect(await readAloudVoice("64 + 7,5 = 71,5", "64 + 7,5 ?", "fr-FR")).toMatchObject({ ok: true, code: "fr" });
	});
});

describe("speakableText — what the voice hears", () => {
	it("drops Markdown marks, so bold is not read as 'asterisk'", () => {
		const md = "## Les contrats\n\nUn **CDD** et un *CDI*.\n\n- [Service public](https://example.org) explique\n- le `CDD`";
		expect(speakableText(md)).toBe("Les contrats\nUn CDD et un CDI.\nService public explique\nle CDD");
	});

	it("leaves out a code block", () => {
		expect(speakableText("Avant.\n\n```js\nconst a = 1;\n```\n\nAprès.")).toBe("Avant.\nAprès.");
	});

	// Chatterbox voices an emoji as a sound, a laugh for 😂. (CUR-3987)
	it("drops emoji, including joined, skin-toned and flag sequences, so none is voiced as a sound", () => {
		const md = "Bonne question 😂 ! Voici 👩🏽‍💻 la réponse 🇫🇷 ✔️\n\n- Étape 1 🚀";
		expect(speakableText(md)).toBe("Bonne question ! Voici la réponse\nÉtape 1");
	});

	it("keeps digits, # and * that are text, and only drops a keycap's mark", () => {
		expect(speakableText("Appelez le 3 # ou le \\* puis 1️⃣.")).toBe("Appelez le 3 # ou le * puis 1.");
	});
});

describe("voiceForLanguage — Kokoro's voice for a detected tag", () => {
	it("maps a regional variety to its language's voice", () => {
		expect(voiceForLanguage("por-PT")).toMatchObject({ ok: true, code: "pt" });
		expect(voiceForLanguage("spa-419")).toMatchObject({ ok: true, code: "es" });
	});

	it("maps the detectors' individual-language tags to the voice's code", () => {
		expect(voiceForLanguage("cmn")).toMatchObject({ ok: true, code: "zh" });
	});

	it.each([
		["fra", "fr", "ff_siwis"],
		["spa", "es", "ef_dora"],
		["por", "pt", "pf_dora"],
		["ita", "it", "if_sara"],
	])("reads %s with that language's own Kokoro voice, never an English one (CUR-3989)", (tag, code, voice) => {
		expect(voiceForLanguage(tag)).toMatchObject({ ok: true, code });
		expect(KOKORO_VOICES[code as keyof typeof KOKORO_VOICES]).toBe(voice);
	});

	it("gives every voice the language prefix of the code it reads, so pronunciation follows the answer (CUR-3989)", () => {
		// Kokoro pronounces by the voice's first letter: a=American English, e=Spanish, f=French, h=Hindi,
		// i=Italian, j=Japanese, p=Portuguese, z=Chinese. An English voice on a French code is the bug.
		const prefix: Record<string, string> = { en: "a", es: "e", fr: "f", hi: "h", it: "i", ja: "j", pt: "p", zh: "z" };
		for (const [code, voice] of Object.entries(KOKORO_VOICES)) expect([code, voice[0]]).toEqual([code, prefix[code]]);
	});

	it.each([
		["deu", "German"],
		["cat", "Catalan"],
		["nob", "Norwegian Bokmål"],
	])("refuses %s by name, since Kokoro has no voice for it (CUR-3989)", (tag, name) => {
		expect(voiceForLanguage(tag)).toMatchObject({ ok: false, name });
	});

	it("names an accent only for Portuguese, whose voices are all Brazilian", () => {
		expect(voiceAccent("pt")).toBe("Brazilian Portuguese");
		for (const code of Object.keys(KOKORO_VOICES).filter((c) => c !== "pt")) expect(voiceAccent(code)).toBeUndefined();
	});

	it("reads an undetermined language in English, as every answer was read before", () => {
		expect(voiceForLanguage("und")).toMatchObject({ ok: true, code: "en" });
	});

	it("refuses a language with no voice, including one that shares a parent's script", () => {
		expect(voiceForLanguage("ukr")).toEqual({ ok: false, tag: "ukr", name: "Ukrainian" });
		expect(voiceForLanguage("cat-valencia")).toMatchObject({ ok: false, name: "Catalan" });
	});
});

describe("maybeRunMcpTool — read-aloud reads the answer in its language, or says it can't", () => {
	beforeEach(() => {
		for (const k of Object.keys(mockConfig)) delete mockConfig[k];
		mockConfig.BETTER_AUTH_SECRET = "test-secret-for-sealing-clips";
		vi.resetModules();
	});

	it("hands back a clip URL that opens to the French text with language fr", async () => {
		const { maybeRunMcpTool } = await import("./index");
		const res = await maybeRunMcpTool("Read this aloud", { conversationId: CONV, synthesizeText: FR });
		expect(res).toMatchObject({ tool: "read_aloud" });
		const url = (res as { result: string }).result;
		expect(url).toMatch(/^\/chat\/api\/speech\/[\w.-]+\.mp3$/);
		// The segment is random base64url, so a short word like "CDD" turns up in it about once in
		// 1,000 runs (CUR-4121). Check the decoded bytes for the whole text, and the URL for a word long
		// enough that chance never spells it.
		const segment = url.split("/").pop()!.replace(/\.mp3$/, "");
		const sealedBytes = Buffer.from(segment.slice(segment.indexOf(".") + 1), "base64url");
		expect(sealedBytes.includes(Buffer.from(FR)), "the clip text sits unsealed in the URL").toBe(false);
		expect(url).not.toContain("contrat");
		expect(openSpeechClip(url.split("/").pop()!)).toEqual({ text: FR, language: "fr", conversation: CONV.toString() });
	});

	it("the clip URL is found as audio by the helpers the turn uses to surface it", async () => {
		const { maybeRunMcpTool, extractMediaUrls, isAudioUrl } = await import("./index");
		const res = await maybeRunMcpTool("Read this aloud", { conversationId: CONV, synthesizeText: ES });
		const url = (res as { result: string }).result;
		expect(extractMediaUrls(url).find(isAudioUrl)).toBe(url);
	});

	it("skips a Yoruba answer with its name and synthesizes nothing", async () => {
		const { maybeRunMcpTool } = await import("./index");
		const res = await maybeRunMcpTool("Read this aloud", { conversationId: CONV, synthesizeText: YO });
		expect(res).toMatchObject({ skipped: true, unsupportedLanguage: "Yoruba" });
	});

	it("reads a mostly-numeric English answer as a clip, with no unsupported-language note or fallback offer", async () => {
		const { maybeRunMcpTool } = await import("./index");
		const res = await maybeRunMcpTool("Check: does 64.00 plus 7.50 equal 71.50?", {
			conversationId: CONV,
			synthesizeText: "Yes, 64.00 + 7.50 = 71.50.",
			fallbackLanguage: "en",
		});
		expect(res).toMatchObject({ tool: "read_aloud" });
		expect(res).not.toHaveProperty("unsupportedLanguage");
		expect(openSpeechClip((res as { result: string }).result.split("/").pop()!)).toMatchObject({ language: "en" });
	});

	it("offers the German answer in the English voice without playing it: the clip is a fallback, not the audio (CUR-3989)", async () => {
		const { maybeRunMcpTool } = await import("./index");
		const res = await maybeRunMcpTool("Read this aloud", { conversationId: CONV, synthesizeText: DE });
		expect(res).toMatchObject({ skipped: true, unsupportedLanguage: "German" });
		expect(res).not.toHaveProperty("result");
		const fallback = (res as { fallbackAudio?: string }).fallbackAudio;
		expect(fallback).toMatch(/^\/chat\/api\/speech\/[\w.-]+\.mp3$/);
		expect(openSpeechClip(fallback!.split("/").pop()!)).toEqual({ text: DE, language: "en", conversation: CONV.toString() });
	});

	it("names the Brazilian accent on a Portuguese clip, and no accent on a French one (CUR-3989)", async () => {
		const { maybeRunMcpTool } = await import("./index");
		const pt = await maybeRunMcpTool("Read this aloud", { conversationId: CONV, synthesizeText: PT });
		expect(pt).toMatchObject({ tool: "read_aloud", voice: "Brazilian Portuguese" });
		const fr = await maybeRunMcpTool("Read this aloud", { conversationId: CONV, synthesizeText: FR });
		expect(fr).toMatchObject({ tool: "read_aloud" });
		expect(fr).not.toHaveProperty("voice");
	});

	it("refuses a clip sealed under another environment's secret", async () => {
		const { maybeRunMcpTool } = await import("./index");
		const res = await maybeRunMcpTool("Read this aloud", { conversationId: CONV, synthesizeText: EN });
		const segment = (res as { result: string }).result.split("/").pop()!;
		mockConfig.BETTER_AUTH_SECRET = "another-environment";
		expect(openSpeechClip(segment)).toBeNull();
	});
});

describe("synthesizeSpeech — the router request", () => {
	it("asks DeepInfra's Kokoro for an MP3 in the clip language's own voice, billed to the org", async () => {
		mockConfig.HF_TOKEN = "hf_test";
		mockConfig.HF_BILL_TO = "example-org";
		const fetchMock = vi.fn().mockResolvedValue(new Response("x"));
		vi.stubGlobal("fetch", fetchMock);
		try {
			await synthesizeSpeech({ text: PT, language: "pt", conversation: CONV.toString() });
		} finally {
			vi.unstubAllGlobals();
		}
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://router.huggingface.co/deepinfra/v1/openai/audio/speech");
		expect(init.headers).toMatchObject({ Authorization: "Bearer hf_test", "X-HF-Bill-To": "example-org" });
		expect(JSON.parse(init.body)).toEqual({
			input: PT,
			model: "hexgrad/Kokoro-82M",
			voice: "pf_dora",
			response_format: "mp3",
		});
	});

	it("refuses a clip in a language with no voice rather than reading it in another voice (CUR-3989)", async () => {
		mockConfig.HF_TOKEN = "hf_test";
		const fetchMock = vi.fn().mockResolvedValue(new Response("x"));
		vi.stubGlobal("fetch", fetchMock);
		try {
			await expect(synthesizeSpeech({ text: "Guten Tag.", language: "de", conversation: CONV.toString() })).rejects.toThrow(
				/no voice/
			);
		} finally {
			vi.unstubAllGlobals();
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
