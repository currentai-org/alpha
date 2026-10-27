import { describe, it, expect, vi, beforeEach } from "vitest";

// dictationMode reads TRANSCRIPTION_MODEL through the `config` proxy; the server test setup mocks
// $env to a static snapshot, so mock `config` directly with a mutable object we can vary per test.
const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

// The FLAG is the gate now; drive its answer directly. flags.spec.ts covers the plane's polling.
const flagEnabledOrMock = vi.fn((_key: string, fallback: () => boolean) => fallback());
vi.mock("$lib/chat/server/flags", () => ({
	flagEnabledOr: flagEnabledOrMock,
}));

// A missing model while the flag is ON must be LOUD, not silent — assert the warn fires.
const warnMock = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: warnMock, info: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
	for (const k of Object.keys(cfg)) delete cfg[k];
	flagEnabledOrMock.mockReset();
	flagEnabledOrMock.mockImplementation((_key, fallback) => fallback());
	warnMock.mockReset();
});

describe("dictationEnabled — the flag is the gate, TRANSCRIPTION_MODEL is config (CUR-198)", () => {
	it("is ON when the flag says on and a transcription model is configured", async () => {
		cfg.TRANSCRIPTION_MODEL = "openai/whisper-large-v3-turbo";
		flagEnabledOrMock.mockReturnValue(true);
		const { dictationEnabled, DICTATION_FLAG } = await import("./dictationMode");
		expect(dictationEnabled()).toBe(true);
		expect(flagEnabledOrMock.mock.calls[0]![0]).toBe(DICTATION_FLAG);
		expect(warnMock).not.toHaveBeenCalled();
	});

	it("is OFF when the flag turns it off, even with a model configured — the rollback path, no redeploy", async () => {
		cfg.TRANSCRIPTION_MODEL = "openai/whisper-large-v3-turbo";
		flagEnabledOrMock.mockReturnValue(false);
		const { dictationEnabled } = await import("./dictationMode");
		expect(dictationEnabled()).toBe(false);
	});

	it("defaults OFF when PostHog has never been polled — the fallback is false, a gated feature stays closed", async () => {
		cfg.TRANSCRIPTION_MODEL = "openai/whisper-large-v3-turbo";
		// The mock calls fallback() by default, exercising the real fallback the code passes.
		const { dictationEnabled } = await import("./dictationMode");
		expect(dictationEnabled()).toBe(false);
		const [, fallback] = flagEnabledOrMock.mock.calls[0]!;
		expect(fallback()).toBe(false);
	});

	// A missing model is not a silent off. It is a loud config error.
	it("flag ON but TRANSCRIPTION_MODEL unset is a LOUD config error, not a silent toggle — withheld + warned", async () => {
		flagEnabledOrMock.mockReturnValue(true);
		const { dictationEnabled } = await import("./dictationMode");
		expect(dictationEnabled()).toBe(false);
		expect(warnMock).toHaveBeenCalledOnce();
		expect(warnMock.mock.calls[0]![0]).toContain("TRANSCRIPTION_MODEL");
	});

	it("whitespace-only model string counts as unset — same loud config error", async () => {
		cfg.TRANSCRIPTION_MODEL = "   ";
		flagEnabledOrMock.mockReturnValue(true);
		const { dictationEnabled } = await import("./dictationMode");
		expect(dictationEnabled()).toBe(false);
		expect(warnMock).toHaveBeenCalledOnce();
	});

	it("never consults the model when the flag is off — the flag is the gate, checked first", async () => {
		cfg.TRANSCRIPTION_MODEL = "openai/whisper-large-v3-turbo";
		flagEnabledOrMock.mockReturnValue(false);
		const { dictationEnabled } = await import("./dictationMode");
		expect(dictationEnabled()).toBe(false);
		expect(warnMock).not.toHaveBeenCalled();
	});

	it("transcriptionModelConfigured reports readiness independent of the flag", async () => {
		cfg.TRANSCRIPTION_MODEL = "  openai/whisper-large-v3-turbo  ";
		const { transcriptionModelConfigured } = await import("./dictationMode");
		expect(transcriptionModelConfigured()).toBe(true);
	});
});
