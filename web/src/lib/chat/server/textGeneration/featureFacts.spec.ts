import { describe, it, expect, vi, beforeEach } from "vitest";

const gates = vi.hoisted(() => ({ scanner: true, multimodal: true, dictation: true, images: true, documents: true, readAloud: true }));
vi.mock("$lib/chat/server/storage/csamScan", () => ({ csamScanConfigured: () => gates.scanner }));
vi.mock("$lib/chat/server/dictationMode", () => ({ dictationEnabled: () => gates.dictation }));
vi.mock("$lib/chat/server/multimodalMode", () => ({ modelTakesImagesNow: () => gates.images, multimodalEnabled: () => gates.multimodal }));
vi.mock("$lib/chat/server/documentAttachmentsGate", () => ({ documentAttachmentsOffered: () => gates.documents }));
vi.mock("$lib/chat/server/readAloudGate", () => ({ readAloudEnabled: () => gates.readAloud }));

const { resolveFeatureFacts, featuresClause } = await import("./persona");

// The prompt may name only what this visitor's composer shows. The composer drops the whole
// attach control when no upload scanner is configured (layoutData.ts), so the prompt must too, or the
// model offers a guest an upload button that isn't there. (CUR-3200)
describe("resolveFeatureFacts (CUR-3200)", () => {
	beforeEach(() => Object.assign(gates, { scanner: true, multimodal: true, dictation: true, images: true, documents: true, readAloud: true }));

	it("offers images and documents only when the composer's attach control exists (scanner configured)", () => {
		gates.scanner = false;
		const facts = resolveFeatureFacts({ multimodal: true });
		expect(facts).toEqual({ dictation: true, textFiles: false, noAttach: "off", images: false, documents: false, readAloud: true, otherModels: [], answering: expect.objectContaining({ openness: expect.any(String) }), readAloudMode: "auto" });
		expect(featuresClause(facts)).not.toMatch(/image|photo|PDF|text files/i);
	});

	it("follows each gate with the scanner present, so an off gate is never claimed", () => {
		expect(resolveFeatureFacts({ multimodal: true })).toEqual({
			dictation: true,
			textFiles: true,
			images: true,
			documents: true,
			readAloud: true,
			otherModels: [],
			answering: expect.objectContaining({ openness: expect.any(String) }),
			readAloudMode: "auto",
		});
		Object.assign(gates, { scanner: false, dictation: false, images: false, documents: false, readAloud: false });
		// Every feature off leaves one sentence: that files can't be added here (CUR-3976).
		expect(featuresClause({ ...resolveFeatureFacts({ multimodal: true }), webSearch: undefined })).toMatch(/^This conversation can't take files\b[^]*paste/);
	});

	it("names text files wherever the attach control exists, even with PDFs and images off (mozfest's set)", () => {
		Object.assign(gates, { images: false, documents: false });
		const clause = featuresClause(resolveFeatureFacts({ multimodal: false }));
		expect(clause).toMatch(/text files \(\.txt, \.md, \.csv, JSON\) attached to a message/);
		expect(clause).toMatch(/say it has no .*file uploads/);
		expect(clause).not.toMatch(/PDF|photo/);
	});
});

// The prompt must not say "This app offers text files … attached to a message" to visitors
// whose composer has no attach control, or the model sends them to a paperclip. The text-file sentence
// follows every gate the server refuses a file on, and a visitor without the control is told to paste. (CUR-3976)
describe("never offers a file control the composer doesn't show (CUR-3976)", () => {
	const signedIn = { loginOffered: true, signedIn: true };
	const guest = { loginOffered: true, signedIn: false };
	const PAPERCLIP_DENIED = /Never tell them to click a paperclip/;
	beforeEach(() => Object.assign(gates, { scanner: true, multimodal: true, dictation: true, images: true, documents: true, readAloud: true }));

	it("gives an account outside the multimodal flag no text-file sentence and tells it to paste", () => {
		gates.multimodal = false;
		const facts = resolveFeatureFacts({ id: "mistral-large-2512" }, { account: signedIn });
		expect(facts).toMatchObject({ textFiles: false, images: false, documents: false, noAttach: "off" });
		const clause = featuresClause(facts);
		expect(clause).not.toMatch(/text files|Attach files|PDF|photo/);
		expect(clause).toMatch(/can't take files[^]*paste its text into the message/);
		expect(clause).toMatch(PAPERCLIP_DENIED);
	});

	it("tells a guest where sign-in is offered to sign in or paste, and offers no file", () => {
		const facts = resolveFeatureFacts({ multimodal: true }, { account: guest });
		expect(facts).toMatchObject({ textFiles: false, images: false, documents: false, noAttach: "sign-in" });
		const clause = featuresClause(facts);
		expect(clause).not.toMatch(/This app offers[^.]*(text files|photos|PDF)/);
		expect(clause).toMatch(/Attaching files needs signing in[^]*paste its text into the message/);
		expect(clause).toMatch(PAPERCLIP_DENIED);
	});

	it("offers a guest files where the deployment has no sign-in, since the server takes them there", () => {
		const facts = resolveFeatureFacts({ multimodal: true }, { account: { loginOffered: false, signedIn: false } });
		expect(facts).toMatchObject({ textFiles: true });
		expect(facts.noAttach).toBeUndefined();
	});

	it("names the real control for a signed-in account inside the flag, on a model that reads no images", () => {
		gates.images = false;
		const facts = resolveFeatureFacts({ id: "mistral-large-2512" }, { account: signedIn });
		expect(facts).toMatchObject({ textFiles: true, images: false });
		const clause = featuresClause(facts);
		expect(clause).toMatch(/text files \(\.txt, \.md, \.csv, JSON\) attached to a message with "Attach files" in the "\+" menu/);
		expect(clause).not.toMatch(/paperclip|can't take files/);
	});
});

// The facts come from what the composer shows this visitor: the listed registry and the turn's
// web search mode. Large 3 must not claim it "currently offers only Mistral Large 3" beside a model button
// listing Apertus, or that it can't browse while the Tools menu has web search on. (CUR-3240)
describe("resolveFeatureFacts model choice and web search (CUR-3240)", () => {
	const listed = [
		{ id: "mistral-large-2512", displayName: "Mistral Large 3" },
		{ id: "swiss-ai/apertus-v1.5-70b", displayName: "Apertus 1.5 70B" },
		{ id: "potluck-agent", displayName: "Agent", unlisted: true },
	];

	it("marks the native turn's facts as having search_catalog, and the pipeline turn's as not (CUR-3889)", () => {
		expect(resolveFeatureFacts({ id: "m" }, { catalogTool: true }).catalogTool).toBe(true);
		expect(resolveFeatureFacts({ id: "m" }, {}).catalogTool).toBeUndefined();
	});

	it("lists the other models the model button offers, never the one answering or the unlisted agent", () => {
		const facts = resolveFeatureFacts({ id: "mistral-large-2512" }, { listed });
		expect(facts.otherModels?.map((m) => m.name)).toEqual(["Apertus 1.5 70B"]);
	});

	// Each model is credited to its own maker, not to Current AI. The makers come from
	// identity.ts, the same source as each model's own "made by" line. (CUR-3889)
	it("carries each listed model's maker from identity.ts, and none where identity.ts only guesses", () => {
		const facts = resolveFeatureFacts(
			{ id: "mistral-large-2512" },
			{
				listed: [
					...listed,
					{ id: "BSC-LT/ALIA-40b-instruct", displayName: "ALIA 40B" },
					{ id: "someone/unknown-7b", displayName: "Unknown 7B" },
				],
			}
		);
		expect(facts.answering).toEqual({
			name: "Mistral Large 3",
			maker: "Mistral AI",
			openness: "open weights",
			card: "https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512",
			licence: "Apache 2.0",
			languages: "broadly multilingual; also good in English, French, German, Spanish, Italian and Portuguese",
			size: "675 billion parameters",
		});
		// ALIA's served repo is gated (401), so it carries no card; neither does an unknown model (CUR-3913).
		expect(facts.otherModels).toEqual([
			{
				name: "Apertus 1.5 70B",
				maker: "the Swiss National AI Institute (SNAI)",
				openness: "fully open",
				card: "https://huggingface.co/swiss-ai/Apertus-v1.5-70B",
				licence: "Apache 2.0",
				languages: "broadly multilingual",
				size: "72 billion parameters",
			},
			{
				name: "ALIA 40B",
				maker: "the Barcelona Supercomputing Center (BSC)",
				openness: "open weights",
				languages: "built for Spanish, Catalan, Galician and Basque; also good in English, Portuguese and French",
				size: "40 billion parameters",
			},
			{ name: "Unknown 7B", openness: "open weights" },
		]);
	});

	// Without the catalog's languages the model cannot say which model suits Catalan, and without
	// each card's parameter count it can read a version number (GLM 5.2) as a size. Both go in the list. (CUR-4007)
	it("names the model built for each language, and gives each card's parameter count rather than the version", () => {
		const facts = resolveFeatureFacts(
			{ id: "mistral-large-2512" },
			{
				listed: [
					...listed,
					{ id: "BSC-LT/ALIA-40b-instruct", displayName: "ALIA 40B" },
					{ id: "speakleash/Bielik-11B-v3.0-Instruct", displayName: "Bielik 11B v3" },
					{ id: "zai-org/GLM-5.2", displayName: "GLM 5.2" },
				],
			}
		);
		const clause = featuresClause(facts);
		expect(clause).toMatch(/ALIA 40B \(made by the Barcelona Supercomputing Center \(BSC\), open weights, 40 billion parameters, built for Spanish, Catalan, Galician and Basque;/);
		expect(clause).toMatch(/Bielik 11B v3 \([^)]*built for Polish[;,)]/);
		expect(clause).not.toMatch(/Bielik[^)]*Catalan/);
		// A www turn: Large 3 called itself "built for French but strong in English".
		expect(clause).toMatch(/Mistral Large 3 \([^)]*broadly multilingual/);
		expect(clause).not.toMatch(/Mistral[^()]*\([^)]*built for/);
		expect(clause).toMatch(/recommend the one listed as built for it/);
		expect(clause).toMatch(/GLM 5\.2 \([^)]*\)[^,]*, open weights, 753 billion parameters,/);
		expect(clause).toMatch(/never a number in its name or version \(GLM 5\.2 is not 5\.2 billion\)/);
		expect(clause).toMatch(/For a model with no count listed, say you have no verified size and point to its model card/);
	});

	it("reads web search from the turn's mode, and says nothing about search when the turn carries none (CUR-3293)", () => {
		expect(resolveFeatureFacts({}, { webSearchMode: "off" }).webSearch).toBe("off");
		expect(resolveFeatureFacts({}, {}).webSearch).toBeUndefined();
	});
});
