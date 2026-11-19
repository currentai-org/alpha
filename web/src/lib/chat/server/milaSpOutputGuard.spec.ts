// The Mila output guard: off checks nothing, on with the key unset is a loud misconfiguration that checks
// nothing (fail open), and a hit on an en/fr answer stamps the card and ends the conversation, saved before
// the client is told.
import { afterEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ on: false }));
vi.mock("$lib/chat/server/flags", () => ({
	flagEnabledOr: (key: string, fallback: () => boolean) => (key === "mila-sp-output-guard" ? flags.on : fallback()),
}));

import { checkAnswerWithMilaSp, milaSpOutputGuardOn } from "./milaSpOutputGuard";
import { stampSupportFromSignal, type SupportSignal } from "./supportSignal";
import type { Message } from "$lib/chat/types/Message";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

afterEach(() => {
	flags.on = false;
	vi.unstubAllEnvs();
});

describe("milaSpOutputGuardOn", () => {
	it("checks nothing with the flag off, and logs nothing", () => {
		vi.stubEnv("HF_TOKEN", "hf_x");
		vi.stubEnv("MILA_SP_ENDPOINT_URL", "https://mila.test");
		const l = log();
		expect(milaSpOutputGuardOn(l)).toBe(false);
		expect(l.error).not.toHaveBeenCalled();
	});

	it("checks the turn with the flag on and HF_TOKEN and MILA_SP_ENDPOINT_URL set", () => {
		flags.on = true;
		vi.stubEnv("HF_TOKEN", "hf_x");
		vi.stubEnv("MILA_SP_ENDPOINT_URL", "https://mila.test");
		const l = log();
		expect(milaSpOutputGuardOn(l)).toBe(true);
		expect(l.error).not.toHaveBeenCalled();
	});

	it("checks nothing (fail open) but logs an error when the flag is on and HF_TOKEN is unset", () => {
		flags.on = true;
		vi.stubEnv("HF_TOKEN", "");
		const l = log();
		expect(milaSpOutputGuardOn(l)).toBe(false);
		expect(l.error).toHaveBeenCalledTimes(1);
		expect(l.error.mock.calls[0][1]).toContain("HF_TOKEN or MILA_SP_ENDPOINT_URL is unset");
	});

	it("checks nothing (fail open) but logs an error when the flag is on with HF_TOKEN set and no endpoint (a self-host)", () => {
		flags.on = true;
		vi.stubEnv("HF_TOKEN", "hf_x");
		vi.stubEnv("MILA_SP_ENDPOINT_URL", "");
		vi.stubEnv("DEPLOY_ENV", "");
		vi.stubEnv("VERCEL_ENV", "");
		const l = log();
		expect(milaSpOutputGuardOn(l)).toBe(false);
		expect(l.error).toHaveBeenCalledTimes(1);
		expect(l.error.mock.calls[0][1]).toContain("MILA_SP_ENDPOINT_URL");
	});
});

describe("checkAnswerWithMilaSp", () => {
	type Res = Awaited<ReturnType<typeof import("$lib/chat/server/detectors/milaSp").milaSpScore>>;
	const UNSAFE: Res = { verdict: "unsafe", score: 0.93 };

	function setup(opts: { tag?: string; res?: Res; moderation?: Message["moderation"] } = {}) {
		flags.on = true;
		vi.stubEnv("HF_TOKEN", "hf_x");
		vi.stubEnv("MILA_SP_ENDPOINT_URL", "https://mila.test");
		const events: string[] = [];
		const message: Pick<Message, "moderation"> = { moderation: opts.moderation };
		const conv: { crisisEndedAt?: Date } = {};
		const score = vi.fn(async () => opts.res ?? UNSAFE);
		const readLanguage = vi.fn(async () => ("tag" in opts ? opts.tag : "eng"));
		const persist = vi.fn(async () => {
			// What the save would write, at the moment it is called.
			events.push(`persist crisisEndedAt=${conv.crisisEndedAt instanceof Date} support=${message.moderation?.support}`);
		});
		const updates: MessageUpdate[] = [];
		const update = vi.fn(async (e: MessageUpdate) => {
			events.push(`update ${e.type}`);
			updates.push(e);
		});
		const run = (answer = "Some answer.") =>
			checkAnswerWithMilaSp({
				answer,
				message,
				conv,
				signal: new AbortController().signal,
				persist,
				update,
				log: log(),
				score,
				readLanguage,
			});
		return { run, message, conv, score, readLanguage, persist, update, updates, events };
	}

	it("checks an English answer and a French one", async () => {
		for (const tag of ["eng", "fra"]) {
			const s = setup({ tag, res: { verdict: "safe", score: 0.02 } });
			await s.run();
			expect(s.score, tag).toHaveBeenCalledTimes(1);
		}
	});

	it("skips an answer in any other language, or whose language is unknown, without calling the endpoint", async () => {
		for (const tag of ["deu", "spa", undefined]) {
			const s = setup({ tag });
			await s.run();
			expect(s.score, String(tag)).not.toHaveBeenCalled();
			expect(s.conv.crisisEndedAt).toBeUndefined();
		}
	});

	it("skips every answer with the flag off", async () => {
		const s = setup();
		flags.on = false;
		await s.run();
		expect(s.readLanguage).not.toHaveBeenCalled();
		expect(s.score).not.toHaveBeenCalled();
		expect(s.update).not.toHaveBeenCalled();
	});

	it("skips an empty answer", async () => {
		const s = setup();
		await s.run("   ");
		expect(s.score).not.toHaveBeenCalled();
	});

	it("on a hit, saves the ended conversation and the card BEFORE the client is told, then sends conversationEnded", async () => {
		const s = setup();
		await s.run();
		expect(s.conv.crisisEndedAt).toBeInstanceOf(Date);
		expect(s.events).toEqual(["persist crisisEndedAt=true support=true", `update ${MessageUpdateType.SupportNotice}`]);
		expect(s.updates[0]).toEqual({ type: MessageUpdateType.SupportNotice, supportLang: "en", conversationEnded: true });
	});

	it("names the card's language from a French answer", async () => {
		const s = setup({ tag: "fra" });
		await s.run();
		expect(s.message.moderation?.supportLang).toBe("fr");
		expect(s.updates[0]).toMatchObject({ supportLang: "fr", conversationEnded: true });
	});

	it("fails open: a safe or unknown verdict changes nothing and tells the client nothing", async () => {
		for (const res of [{ verdict: "safe", score: 0.2 }, { verdict: "unknown", reason: "timeout" }] as Res[]) {
			const s = setup({ res });
			await s.run();
			expect(s.conv.crisisEndedAt).toBeUndefined();
			expect(s.message.moderation).toBeUndefined();
			expect(s.persist).not.toHaveBeenCalled();
			expect(s.update).not.toHaveBeenCalled();
		}
	});

	it("mutates the message's moderation object in place, keeping what the input screen stamped", async () => {
		const moderation: NonNullable<Message["moderation"]> = {
			flagged: false,
			label: null,
			score: 0.1,
			kind: "toxicity",
			screened: true,
			supportLang: "fr",
		};
		const s = setup({ moderation });
		await s.run();
		expect(s.message.moderation).toBe(moderation);
		expect(moderation).toMatchObject({ screened: true, support: true, supportLang: "fr" });
	});

	it("keeps the support signal's late supportCountry on the saved card when the signal resolves after the hit", async () => {
		const moderation: NonNullable<Message["moderation"]> = { flagged: false, label: null, score: 0, kind: "toxicity" };
		const s = setup({ moderation });
		let resolveSignal!: (v: SupportSignal) => void;
		const signal = new Promise<SupportSignal>((r) => (resolveSignal = r));
		// The route starts this on the same object before the answer streams; the final persist awaits it.
		const verdict = stampSupportFromSignal(s.message.moderation!, signal, async () => {});
		await s.run();
		resolveSignal({ show: true, who: "writer", lang: "en", country: "CA" });
		expect(await verdict).toBe(true);
		expect(s.message.moderation).toBe(moderation);
		expect(s.message.moderation).toMatchObject({ support: true, supportLang: "en", supportCountry: "CA" });
	});
});
