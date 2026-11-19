import { describe, it, expect, vi, afterEach } from "vitest";

const { configValues } = vi.hoisted(() => ({ configValues: {} as Record<string, string> }));
vi.mock("$lib/chat/server/config", () => ({ config: configValues }));
vi.mock("$lib/chat/server/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { kokoroVoice } from "./readAloudLanguage";
import { speechConfigured, synthesizeSpeech } from "./readAloudSpeech";

const clip = { text: "Hello there", language: "en" } as Parameters<typeof synthesizeSpeech>[0];

const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("audio"));

async function fetchedUrl(): Promise<string> {
	vi.stubGlobal("fetch", fetchMock);
	await synthesizeSpeech(clip);
	return String(fetchMock.mock.calls[0][0]);
}

function sentHeaders(): Record<string, string> {
	return (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
}

afterEach(() => {
	fetchMock.mockClear();
	for (const k of Object.keys(configValues)) delete configValues[k];
	vi.unstubAllGlobals();
});

describe("read-aloud speech host", () => {
	it("posts to the Hugging Face router route when READ_ALOUD_BASE_URL is unset", async () => {
		configValues.HF_TOKEN = "hf_x";
		expect(await fetchedUrl()).toBe("https://router.huggingface.co/deepinfra/v1/openai/audio/speech");
	});

	it("posts to READ_ALOUD_BASE_URL + /audio/speech when it is set", async () => {
		configValues.HF_TOKEN = "hf_x";
		configValues.READ_ALOUD_BASE_URL = "http://speech:8880/v1";
		expect(await fetchedUrl()).toBe("http://speech:8880/v1/audio/speech");
	});

	it("strips trailing slashes from READ_ALOUD_BASE_URL", async () => {
		configValues.HF_TOKEN = "hf_x";
		configValues.READ_ALOUD_BASE_URL = "http://speech:8880/v1//";
		expect(await fetchedUrl()).toBe("http://speech:8880/v1/audio/speech");
	});

	it("is configured with READ_ALOUD_BASE_URL set and no HF_TOKEN, and posts with no Authorization header", async () => {
		configValues.READ_ALOUD_BASE_URL = "http://speech:8880/v1";
		expect(speechConfigured()).toBe(true);
		await fetchedUrl();
		expect(sentHeaders()).not.toHaveProperty("Authorization");
		expect(sentHeaders()).not.toHaveProperty("X-HF-Bill-To");
	});

	it("sends READ_ALOUD_API_KEY, not HF_TOKEN, as the bearer to a custom host", async () => {
		configValues.READ_ALOUD_BASE_URL = "http://speech:8880/v1";
		configValues.READ_ALOUD_API_KEY = "speech-key";
		configValues.HF_TOKEN = "hf_x";
		await fetchedUrl();
		expect(sentHeaders().Authorization).toBe("Bearer speech-key");
	});

	it("is not configured without HF_TOKEN on the default Hugging Face route", () => {
		expect(speechConfigured()).toBe(false);
	});

	it("sends HF_TOKEN as the bearer on the default Hugging Face route", async () => {
		configValues.HF_TOKEN = "hf_x";
		configValues.READ_ALOUD_API_KEY = "speech-key";
		await fetchedUrl();
		expect(sentHeaders().Authorization).toBe("Bearer hf_x");
	});

	function sentBody(): { model: string; voice: string } {
		return JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
	}

	it("sends READ_ALOUD_MODEL and READ_ALOUD_VOICE to a custom host when both are set", async () => {
		configValues.READ_ALOUD_BASE_URL = "http://speech:8880/v1";
		configValues.READ_ALOUD_MODEL = "tts-1";
		configValues.READ_ALOUD_VOICE = "alloy";
		await fetchedUrl();
		expect(sentBody()).toMatchObject({ model: "tts-1", voice: "alloy" });
	});

	it("sends the Kokoro model and voice to a custom host when READ_ALOUD_MODEL and READ_ALOUD_VOICE are unset", async () => {
		configValues.READ_ALOUD_BASE_URL = "http://speech:8880/v1";
		await fetchedUrl();
		expect(sentBody()).toMatchObject({ model: "hexgrad/Kokoro-82M", voice: kokoroVoice("en") });
	});

	it("ignores READ_ALOUD_MODEL and READ_ALOUD_VOICE on the Hugging Face route and sends Kokoro", async () => {
		configValues.HF_TOKEN = "hf_x";
		configValues.READ_ALOUD_MODEL = "tts-1";
		configValues.READ_ALOUD_VOICE = "alloy";
		await fetchedUrl();
		expect(sentBody()).toMatchObject({ model: "hexgrad/Kokoro-82M", voice: kokoroVoice("en") });
	});
});
