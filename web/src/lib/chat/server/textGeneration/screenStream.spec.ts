import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
	nextChunk,
	screenOutputStream,
	type OutputModerationMarker,
	type OutputScreenLedger,
} from "./screenStream";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";
import type { TurnSpans } from "$lib/chat/types/MessageTimings";
import {
	OUTPUT_CONTENT_DECLINE,
	OUTPUT_CHILD_SAFETY_DECLINE,
	OUTPUT_CONTENT_TRUNCATE,
	OUTPUT_CHILD_SAFETY_TRUNCATE,
	OUTPUT_UNSCREENED_DECLINE,
	OUTPUT_UNSCREENED_TRUNCATE,
	type OutputScreenResult,
} from "$lib/chat/server/moderation";
import { logger } from "$lib/chat/server/logger.js";
import { resolveActionMessage } from "$lib/chat/server/ruleLabel";

// Build an async source from a list of events (mirrors textGeneration's event stream).
async function* src(events: MessageUpdate[]): AsyncGenerator<MessageUpdate> {
	for (const e of events) yield e;
}
const tok = (token: string): MessageUpdate => ({ type: MessageUpdateType.Stream, token });
const fin = (text: string, interrupted = false): MessageUpdate => ({
	type: MessageUpdateType.FinalAnswer,
	text,
	interrupted,
});
const status = (): MessageUpdate => ({
	type: MessageUpdateType.Status,
	// minimal Status shape; only `type` matters for pass-through
	status: "keepAlive" as never,
});

async function drain(gen: AsyncGenerator<MessageUpdate>) {
	const out: MessageUpdate[] = [];
	for await (const e of gen) out.push(e);
	return out;
}
const streamedText = (events: MessageUpdate[]) =>
	events
		.filter(
			(e): e is Extract<MessageUpdate, { type: MessageUpdateType.Stream }> =>
				e.type === MessageUpdateType.Stream
		)
		.map((e) => e.token)
		.join("");
const finalOf = (events: MessageUpdate[]) =>
	events.find(
		(e): e is Extract<MessageUpdate, { type: MessageUpdateType.FinalAnswer }> =>
			e.type === MessageUpdateType.FinalAnswer
	);

const clean: OutputScreenResult = { blocked: false, kind: null };
const blockContent: OutputScreenResult = { blocked: true, kind: "content_policy", category: "x" };
const blockChild: OutputScreenResult = { blocked: true, kind: "child_safety" };
// A child query the guard never answered: fail closed, but nothing was flagged (CUR-3891).
const unscreenedChild: OutputScreenResult = { blocked: true, kind: "child_safety", unscreened: true };
// A block whose action HAS a curated label (chat-block-violence → "Violent content" in rules.json).
const blockNamed: OutputScreenResult = {
	blocked: true,
	kind: "content_policy",
	category: "chat-block-violence",
};

describe("screenOutputStream — re-check of a flagged batch (CUR-3975)", () => {
	const flaggedToxic: OutputScreenResult = {
		blocked: true,
		kind: "content_policy",
		category: "chat-block-toxic",
		hits: [{ key: "chat-block-toxic", action: "block", tier: "content" }],
	};

	it("releases a batch the re-check clears, and the answer goes on to its end", async () => {
		const screen = vi.fn(async (text: string) => (text.includes("FLAGGED") ? flaggedToxic : clean));
		const recheck = vi.fn(async () => clean);
		let marker: OutputModerationMarker | undefined;
		const events = await drain(
			screenOutputStream(src([tok("Safe one. "), tok("FLAGGED two. "), tok("Three.")]), {
				screen,
				recheck,
				onModeration: (m) => (marker = m),
			})
		);
		expect(streamedText(events)).toBe("Safe one. FLAGGED two. Three.");
		expect(finalOf(events)?.text).not.toContain(OUTPUT_CONTENT_TRUNCATE);
		expect(marker).toMatchObject({ flagged: false, screened: true, rechecked: 1 });
		expect(recheck).toHaveBeenCalledTimes(1);
	});

	it("cuts the answer as before when the re-check keeps the block", async () => {
		const screen = vi.fn(async (text: string) => (text.includes("FLAGGED") ? flaggedToxic : clean));
		const recheck = vi.fn(async (_prior: string, _batch: string, first: OutputScreenResult) => first);
		const events = await drain(
			screenOutputStream(src([tok("Safe one. "), tok("FLAGGED two. "), tok("Three.")]), { screen, recheck })
		);
		expect(streamedText(events)).toBe("Safe one. ");
		expect(finalOf(events)?.text).not.toContain("FLAGGED");
	});

	it("gives the re-check the answer before the flagged batch, the batch, the first verdict and the window left", async () => {
		const opening = "An opening sentence that runs well past the screen's two hundred character context window. ".repeat(4);
		const screen = vi.fn(async (text: string) => (text.includes("FLAGGED") ? flaggedToxic : clean));
		const recheck = vi.fn(async (_prior: string, _batch: string, _first: OutputScreenResult, _budgetMs: number) => clean);
		await drain(screenOutputStream(src([tok(opening), tok("FLAGGED two. ")]), { screen, recheck }));
		expect(recheck).toHaveBeenCalledWith(opening, "FLAGGED two. ", flaggedToxic, expect.any(Number));
		const budgetMs = recheck.mock.calls[0][3] as number;
		expect(budgetMs).toBeGreaterThan(0);
		expect(budgetMs).toBeLessThanOrEqual(25_000);
		// The first screen still reads only the narrow window, so its cost does not grow with the answer.
		const firstScreenOfFlagged = screen.mock.calls.map((c) => c[0]).find((t) => t.includes("FLAGGED"));
		expect(firstScreenOfFlagged?.length).toBeLessThan(opening.length);
	});

	it("starts no re-check once the window has run out, so a flagged batch stays cut", async () => {
		// The flagged batch's first screen outlasts the whole window, so the window is spent before the
		// re-check could start.
		const screen = vi.fn(async (text: string) => {
			if (!text.includes("FLAGGED")) return clean;
			await new Promise((r) => setTimeout(r, 60));
			return flaggedToxic;
		});
		const recheck = vi.fn(async () => clean);
		const events = await drain(
			screenOutputStream(src([tok("FLAGGED one.")]), { screen, recheck, phaseDeadlineMs: 20 })
		);
		expect(recheck).not.toHaveBeenCalled();
		expect(streamedText(events)).not.toContain("FLAGGED");
	});

	it("starts no re-check once finalization has begun", async () => {
		const ledger: OutputScreenLedger = { dispatched: [], stopped: false, released: "" };
		const screen = vi.fn(async (text: string) => {
			if (!text.includes("FLAGGED")) return clean;
			ledger.stopped = true; // the route finalizes while this screen is in flight
			return flaggedToxic;
		});
		const recheck = vi.fn(async () => clean);
		const events = await drain(screenOutputStream(src([tok("FLAGGED one.")]), { screen, recheck, ledger }));
		expect(recheck).not.toHaveBeenCalled();
		expect(streamedText(events)).not.toContain("FLAGGED");
		// The report still reads the first screen's verdict, hits included.
		expect(await ledger.dispatched[0].promise).toBe(flaggedToxic);
	});

	it("never calls the re-check for a batch the first screen released", async () => {
		const recheck = vi.fn(async () => clean);
		await drain(screenOutputStream(src([tok("Safe one. "), tok("Safe two.")]), { screen: async () => clean, recheck }));
		expect(recheck).not.toHaveBeenCalled();
	});
});

describe("nextChunk — sentence/chunk boundary detection", () => {
	it("returns a complete sentence (terminator + whitespace), null when incomplete", () => {
		expect(nextChunk("Hello world. Next")).toBe("Hello world. ");
		expect(nextChunk("Hello world")).toBeNull();
		expect(nextChunk("")).toBeNull();
	});
	it("does NOT split decimals or mid-number periods", () => {
		expect(nextChunk("Pi is 3.14 and")).toBeNull(); // 3.14 has no trailing space after the dot
	});
	it("treats a paragraph break as a boundary", () => {
		expect(nextChunk("A heading\n\nbody")).toBe("A heading\n\n");
	});
	it("force-splits at the char cap (cut on whitespace) when there is no punctuation", () => {
		const long = "word ".repeat(120); // 600 chars, no sentence end
		const c = nextChunk(long);
		expect(c).not.toBeNull();
		expect(c?.length ?? 999).toBeLessThanOrEqual(400);
		expect(c?.endsWith(" ")).toBe(true); // cut on a word boundary
	});
	it("honors a smaller maxChars (first-chunk fast path)", () => {
		const long = "word ".repeat(120); // 600 chars, no sentence end
		const c = nextChunk(long, 120);
		expect(c).not.toBeNull();
		expect(c?.length ?? 999).toBeLessThanOrEqual(120);
		// a sentence terminator still wins over the cap (a short opener is unaffected)
		expect(nextChunk("Hi there. and then a much longer tail well past the cap", 120)).toBe(
			"Hi there. "
		);
	});
});

describe("screenOutputStream — hold-and-release per sentence", () => {
	it("clean multi-sentence: releases every chunk and finalizes with the full text", async () => {
		const screen = vi.fn(async () => clean);
		let marker: OutputModerationMarker | undefined;
		const events = await drain(
			screenOutputStream(
				src([tok("One. "), tok("Two. "), tok("Three."), fin("One. Two. Three.")]),
				{
					screen,
					onModeration: (m) => (marker = m),
				}
			)
		);
		expect(streamedText(events)).toBe("One. Two. Three.");
		expect(finalOf(events)?.text).toBe("One. Two. Three.");
		expect(marker).toMatchObject({ flagged: false, screened: true });
	});

	// textGeneration's explicit read-aloud path suppresses every Stream token (so a decline never
	// flashes) and yields only a composed FinalAnswer (CUR-2045). Composing the answer from an empty
	// `released` buffer would make the route report "No output was generated" on a turn the model
	// answered.
	it("screens and releases a FinalAnswer that arrives with no Stream tokens before it, rather than dropping it", async () => {
		const screen = vi.fn(async (_text: string) => clean);
		const events = await drain(
			screenOutputStream(src([status(), fin("The bread is in the oven.")]), { screen })
		);
		expect(finalOf(events)?.text, "the answer was dropped, so the route sees no output").toBe(
			"The bread is in the oven."
		);
		expect(screen, "the answer reached the user without being screened").toHaveBeenCalled();
		expect(screen.mock.calls.map((c) => c[0]).join("")).toContain("The bread is in the oven.");
	});

	it("a FinalAnswer with no Stream tokens before it can still be blocked", async () => {
		const screen = vi.fn(async () => blockContent);
		const events = await drain(screenOutputStream(src([fin("Bad composed answer.")]), { screen }));
		expect(streamedText(events)).toBe("");
		expect(finalOf(events)?.text).toBe(OUTPUT_CONTENT_DECLINE);
	});

	it("blocked MIDDLE sentence: keeps the cleared prefix, appends a truncation notice", async () => {
		const screen = vi.fn(async (text: string) => (text.includes("BAD") ? blockContent : clean));
		let marker: OutputModerationMarker | undefined;
		const events = await drain(
			screenOutputStream(src([tok("Safe one. "), tok("BAD two. "), tok("Three.")]), {
				screen,
				onModeration: (m) => (marker = m),
			})
		);
		expect(streamedText(events)).toBe("Safe one. "); // only the cleared prefix streamed
		const final = finalOf(events);
		expect(final?.text.startsWith("Safe one.")).toBe(true);
		expect(final?.text).toContain(OUTPUT_CONTENT_TRUNCATE);
		expect(final?.text).not.toContain("BAD");
		expect(marker).toMatchObject({ flagged: true, truncated: true, kind: "content_policy" });
		// no Safety event (would mis-frame an output block as an input decline)
		expect(events.some((e) => e.type === MessageUpdateType.Safety)).toBe(false);
	});

	// THE CONTRACT: this function throws away the upstream FinalAnswer's text and composes its own body
	// from the screened Stream tokens. Anything a producer expressed AS TEXT on that update is lost
	// here. A token-cap notice written that way never reaches the user, so the truncation has to
	// survive as a FLAG, exactly like `interrupted` does (CUR-149).
	it("carries the upstream truncated flag onto the composed final answer", async () => {
		const screen = vi.fn(async () => clean);
		const events = await drain(
			screenOutputStream(
				src([
					tok("A capped thought. "),
					tok("It stops mid-"),
					// The producer's own text is discarded by design; only the flag can survive.
					{ type: MessageUpdateType.FinalAnswer, text: "IGNORED", interrupted: false, truncated: true },
				]),
				{ screen }
			)
		);
		const final = finalOf(events);
		expect(final?.truncated).toBe(true);
		expect(final?.text).toBe("A capped thought. It stops mid-");
	});

	it("does not claim truncation on an answer that finished on its own", async () => {
		const screen = vi.fn(async () => clean);
		const events = await drain(
			screenOutputStream(src([tok("All done."), fin("All done.")]), { screen })
		);
		expect(finalOf(events)?.truncated).toBeUndefined();
	});

	it("stamps a curated ruleLabel on the marker when the blocking action has one", async () => {
		const screen = vi.fn(async (text: string) => (text.includes("BAD") ? blockNamed : clean));
		let marker: OutputModerationMarker | undefined;
		await drain(
			screenOutputStream(src([tok("Fine. "), tok("BAD next.")]), {
				screen,
				onModeration: (m) => (marker = m),
			})
		);
		expect(marker?.ruleLabel).toBe("Violent content");
	});

	it("omits ruleLabel when the blocking action has no curated label (generic copy stands)", async () => {
		const screen = vi.fn(async () => blockContent); // category "x" → no label
		let marker: OutputModerationMarker | undefined;
		await drain(
			screenOutputStream(src([tok("Bad first. ")]), { screen, onModeration: (m) => (marker = m) })
		);
		expect(marker?.flagged).toBe(true);
		expect(marker?.ruleLabel).toBeUndefined();
	});

	it("blocked FIRST sentence: nothing shown → whole-answer decline", async () => {
		const screen = vi.fn(async () => blockContent);
		let marker: OutputModerationMarker | undefined;
		const events = await drain(
			screenOutputStream(src([tok("Bad first. "), tok("more")]), {
				screen,
				onModeration: (m) => (marker = m),
			})
		);
		expect(streamedText(events)).toBe(""); // nothing released
		expect(finalOf(events)?.text).toBe(OUTPUT_CONTENT_DECLINE);
		expect(marker).toMatchObject({ flagged: true, truncated: false });
	});

	it("child-safety block uses the child decline copy + kind", async () => {
		const screen = vi.fn(async () => blockChild);
		let marker: OutputModerationMarker | undefined;
		const events = await drain(
			screenOutputStream(src([tok("Bad. ")]), { screen, onModeration: (m) => (marker = m) })
		);
		expect(finalOf(events)?.text).toBe(OUTPUT_CHILD_SAFETY_DECLINE);
		expect(marker).toMatchObject({ kind: "child_safety", flagged: true });
	});

	it("child truncation copy when a prefix was already shown", async () => {
		const screen = vi.fn(async (t: string) => (t.includes("BAD") ? blockChild : clean));
		const events = await drain(
			screenOutputStream(src([tok("Fine. "), tok("BAD next.")]), { screen })
		);
		expect(finalOf(events)?.text).toContain(OUTPUT_CHILD_SAFETY_TRUNCATE);
	});

	it("an unanswered child screen holds the answer back saying the check couldn't finish, never that a classifier flagged it (CUR-3891)", async () => {
		const screen = vi.fn(async () => unscreenedChild);
		const markers: OutputModerationMarker[] = [];
		const events = await drain(
			screenOutputStream(src([tok("Fine answer. ")]), { screen, onModeration: (m) => markers.push(m) })
		);
		expect(streamedText(events)).toBe("");
		expect(finalOf(events)?.text).toBe(OUTPUT_UNSCREENED_DECLINE);
		expect(finalOf(events)?.text).not.toMatch(/classifier/i);
		expect(markers.at(-1), "the saved marker must say the answer went unchecked").toMatchObject({
			flagged: true,
			unscreened: true,
		});
	});

	it("an unanswered child screen after a cleared prefix appends the couldn't-finish notice, not the child-safety one (CUR-3891)", async () => {
		const screen = vi.fn(async (t: string) => (t.includes("LATER") ? unscreenedChild : clean));
		const events = await drain(
			screenOutputStream(src([tok("Fine. "), tok("LATER next.")]), { screen })
		);
		expect(finalOf(events)?.text).toContain(OUTPUT_UNSCREENED_TRUNCATE);
		expect(finalOf(events)?.text).not.toContain(OUTPUT_CHILD_SAFETY_TRUNCATE);
	});

	it("passes non-content events through (watchdog re-arm) and screens the trailing partial", async () => {
		const screen = vi.fn(async () => clean);
		const events = await drain(
			screenOutputStream(src([status(), tok("No terminal punctuation here")]), { screen })
		);
		expect(events.some((e) => e.type === MessageUpdateType.Status)).toBe(true);
		expect(streamedText(events)).toBe("No terminal punctuation here"); // trailing partial released
		expect(screen).toHaveBeenCalledTimes(1);
	});

	it("delivers a passthrough event that arrives WHILE a screen call is pending, not after (keepalive fix)", async () => {
		// Passthrough delivery must not wait on `head.promise` for the whole screen call: a KeepAlive
		// queued by the producer while the call is in flight would sit undelivered until the verdict
		// resolved. On a first-batch block (nothing released yet) that leaves the client with zero
		// bytes for the entire call, long enough to trip an edge/CDN idle timeout.
		async function* slowSourceWithStatus(): AsyncGenerator<MessageUpdate> {
			yield tok("First sentence. "); // a complete sentence: dispatched as the first batch immediately
			yield status(); // queued to passthrough WHILE that batch's screen is still gated below
		}
		let releaseFirst!: () => void;
		const gate = new Promise<void>((r) => (releaseFirst = r));
		const screen = vi.fn(async () => {
			await gate; // hold the only screen call open
			return clean;
		});
		const out: MessageUpdate[] = [];
		const done = (async () => {
			for await (const e of screenOutputStream(slowSourceWithStatus(), { screen })) out.push(e);
		})();
		await new Promise((r) => setTimeout(r, 10)); // let the producer push the status event mid-screen
		// Delivered BEFORE the verdict resolves — a delivery gated on the verdict fails this assertion.
		expect(out.some((e) => e.type === MessageUpdateType.Status)).toBe(true);
		expect(streamedText(out)).toBe(""); // the batch itself is still correctly gated, unreleased
		releaseFirst();
		await done;
		expect(streamedText(out)).toBe("First sentence. ");
	});

	it("whitespace-only chunks are released WITHOUT a Coop call", async () => {
		const screen = vi.fn(async () => clean);
		await drain(screenOutputStream(src([tok("Hi.\n\n"), tok("Bye.")]), { screen }));
		// "Hi.\n\n" → "Hi." (1 screen) + "\n\n" (no screen) ; "Bye." trailing (1 screen) = 2 calls
		expect(screen).toHaveBeenCalledTimes(2);
	});

	it("abort stops cleanly: no unscreened tail released, FinalAnswer interrupted", async () => {
		const ctrl = new AbortController();
		const screen = vi.fn(async () => clean);
		async function* aborting(): AsyncGenerator<MessageUpdate> {
			yield tok("First. ");
			ctrl.abort();
			yield tok("Second never screened. ");
		}
		const events = await drain(screenOutputStream(aborting(), { screen, signal: ctrl.signal }));
		expect(streamedText(events)).toBe("First. ");
		expect(streamedText(events)).not.toContain("Second");
		expect(finalOf(events)?.interrupted).toBe(true);
	});

	it("abort with only an unclosed <think> placeholder yields NO FinalAnswer (CUR-1178)", async () => {
		// The bug this pins: an agent turn's own "Working on it…" opener is wrapped in an unclosed <think> tag
		// (endpointAgent.ts) and streamed as real, screened content — so a stall right after it leaves `released`
		// holding only that placeholder. Yielding a FinalAnswer with that raw text regardless would set
		// state.finalAnswerReceived before +server.ts's own abort handler (the one that knows about completed
		// agentConfirmations) ever got a turn — the placeholder would ship as the answer instead of a real "here's
		// what finished" summary, or instead of nothing at all.
		const ctrl = new AbortController();
		const screen = vi.fn(async () => clean);
		async function* aborting(): AsyncGenerator<MessageUpdate> {
			yield tok("<think>\nWorking on it via the open agent…\n\n");
			ctrl.abort();
		}
		const events = await drain(screenOutputStream(aborting(), { screen, signal: ctrl.signal }));
		expect(finalOf(events)).toBeUndefined();
	});

	it("abort with REAL content still finalizes as before — the guard is abort-with-nothing-real only", async () => {
		const ctrl = new AbortController();
		const screen = vi.fn(async () => clean);
		async function* aborting(): AsyncGenerator<MessageUpdate> {
			yield tok("The answer so far. ");
			ctrl.abort();
		}
		const events = await drain(screenOutputStream(aborting(), { screen, signal: ctrl.signal }));
		expect(finalOf(events)?.text).toBe("The answer so far. ");
		expect(finalOf(events)?.interrupted).toBe(true);
	});

	it("an upstream throw propagates instead of silently finalizing with empty text (CUR-782)", async () => {
		// The producer must not swallow a thrown it.next(): otherwise the consumer reads a mid-stream
		// throw exactly like a clean end-of-stream and falls through to an empty FinalAnswer. The caller
		// (+server.ts) would never see an error or log one, and the user would get a silent "No output
		// was generated" with nothing to explain it.
		const screen = vi.fn(async () => clean);
		async function* dying(): AsyncGenerator<MessageUpdate> {
			yield tok("First. ");
			throw new Error("upstream fetch failed");
		}
		await expect(drain(screenOutputStream(dying(), { screen }))).rejects.toThrow(
			"upstream fetch failed"
		);
	});

	it("a throw before any content at all still propagates (not just a mid-stream one)", async () => {
		const screen = vi.fn(async () => clean);
		async function* dyingImmediately(): AsyncGenerator<MessageUpdate> {
			throw new Error("connection refused");

			yield tok("never");
		}
		await expect(drain(screenOutputStream(dyingImmediately(), { screen }))).rejects.toThrow(
			"connection refused"
		);
	});

	it("overlaps generation with screening: producer keeps pulling while a screen is in flight", async () => {
		// Under the old sequential loop, holding the first screen open would block the source at 1 pull.
		// With the producer/consumer split, the whole source drains while screen #1 is still pending.
		let pulls = 0;
		async function* slowSource(): AsyncGenerator<MessageUpdate> {
			for (const t of ["Aaa. ", "Bbb. ", "Ccc."]) {
				pulls++;
				yield tok(t);
			}
		}
		let releaseFirst!: () => void;
		const gate = new Promise<void>((r) => (releaseFirst = r));
		let calls = 0;
		const screen = vi.fn(async () => {
			if (++calls === 1) await gate; // hold the first screen open
			return clean;
		});
		const out: MessageUpdate[] = [];
		const done = (async () => {
			for await (const e of screenOutputStream(slowSource(), { screen })) out.push(e);
		})();
		await new Promise((r) => setTimeout(r, 10)); // let the producer run while screen #1 is held
		expect(pulls).toBe(3); // entire source drained though only one screen has started
		expect(streamedText(out)).toBe(""); // nothing released yet (screen #1 still gated)
		releaseFirst();
		await done;
		expect(streamedText(out)).toBe("Aaa. Bbb. Ccc.");
	});

	it("stops the upstream model (calls source.return) on a block — no wasted generation", async () => {
		let returned = false;
		async function* cancellable(): AsyncGenerator<MessageUpdate> {
			try {
				yield tok("BAD one. ");
				yield tok("two. ");
			} finally {
				returned = true; // the generator's finally runs only if it.return() is invoked (or it ends)
			}
		}
		const screen = vi.fn(async () => blockContent);
		await drain(screenOutputStream(cancellable(), { screen }));
		expect(returned).toBe(true);
	});

	it("first chunk flushes at the smaller cap (faster TTFT) on a long unpunctuated opener", async () => {
		const screen = vi.fn(async () => clean);
		const long = "word ".repeat(80); // 400 chars, no sentence terminator
		const events = await drain(screenOutputStream(src([tok(long)]), { screen }));
		const streams = events.filter(
			(e): e is Extract<MessageUpdate, { type: MessageUpdateType.Stream }> =>
				e.type === MessageUpdateType.Stream
		);
		expect(streams[0].token.length).toBeLessThanOrEqual(120); // first content lands early
		expect(streamedText(events)).toBe(long); // nothing lost — full text still released
	});

	it("each screen includes prior cleared context (cross-chunk evasion guard)", async () => {
		const seen: string[] = [];
		const screen = vi.fn(async (t: string) => {
			seen.push(t);
			return clean;
		});
		await drain(screenOutputStream(src([tok("Alpha. "), tok("Beta.")]), { screen }));
		// second screen should carry the cleared "Alpha. " as context ahead of "Beta."
		expect(seen[1]).toContain("Alpha.");
		expect(seen[1]).toContain("Beta.");
	});
});

describe("screenOutputStream — grouping + pipelining", () => {
	// A realistic ~63-char sentence — long enough that grouping math (MIN_CHUNK_CHARS) is exercised,
	// short enough that toy-scale tests above (all well under the threshold) stay unaffected.
	const SENTENCE = "The quick brown fox jumps over the lazy dog again and again. ";

	it("groups multiple sentences into fewer Coop calls once past the first chunk", async () => {
		const screen = vi.fn(async () => clean);
		const tokens = [tok("Hi. "), ...Array.from({ length: 6 }, () => tok(SENTENCE))];
		const events = await drain(screenOutputStream(src(tokens), { screen }));
		expect(streamedText(events)).toBe("Hi. " + SENTENCE.repeat(6));
		// 1 (first, fast-path) + 1 batch of 4 sentences (crosses MIN_CHUNK_CHARS) + 1 trailing batch of
		// 2 — 3 Coop calls total for 7 sentences, instead of one call per sentence.
		expect(screen).toHaveBeenCalledTimes(3);
	});

	it("pipelines Coop calls: more than one screen call is in flight at once", async () => {
		// COUNTS CONCURRENCY, DOES NOT TIME THE WALL CLOCK. A bound such as
		// `elapsed < 4 * DELAY_MS * 0.85` is simultaneously too tight to survive CI scheduling noise and
		// too loose to prove much (a run that overlapped nothing but got lucky on timer granularity
		// would pass).
		//
		// Overlap is a property, not a duration, so observe it directly: hold a counter across the
		// screen callback and record the high-water mark. Deterministic under any load — the only way
		// maxInFlight exceeds 1 is if the implementation really did start a second call before the
		// first resolved.
		const DELAY_MS = 60;
		let inFlight = 0;
		let maxInFlight = 0;
		const screen = vi.fn(async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, DELAY_MS));
			inFlight--;
			return clean;
		});
		// 12 sentences after the first chunk → exactly 3 grouped batches of 4 (no trailing remainder) +
		// the first chunk = 4 Coop calls total. The delay stays so there IS a window to overlap inside.
		const tokens = [tok("Hi. "), ...Array.from({ length: 12 }, () => tok(SENTENCE))];
		await drain(screenOutputStream(src(tokens), { screen }));
		expect(screen).toHaveBeenCalledTimes(4);
		expect(maxInFlight, "no two screen calls overlapped — the pipeline is running sequentially").
			toBeGreaterThan(1);
		// Also pins the documented pipeline depth, which the old timing bound could not see at all:
		// unbounded speculation would send every batch to Coop at once.
		expect(maxInFlight, "more calls in flight than the documented pipeline depth").toBeLessThanOrEqual(3);
	});

	it("discard-on-block under pipelining: a later speculative batch already in flight is never released", async () => {
		const BAD_SENTENCE = "BAD content sentence goes here and keeps going long enough. ";
		const screen = vi.fn(async (text: string) => (text.includes("BAD") ? blockContent : clean));
		// Batch math (verified by simulating tryTakeBatch against this exact fixture): batch #1 "Hi. "
		// (fast-path), batch #2 = 5 clean sentences (305 chars, crosses MIN_CHUNK_CHARS on its own — the
		// BAD sentence hasn't been seen yet so it can't leak into this batch), batch #3 = BAD + enough
		// trailing sentences to cross the threshold (blocks), batch #4 = the remaining clean sentences —
		// fired speculatively (pipeline depth allows it before batch #3 resolves) but must be discarded.
		const tokens = [
			tok("Hi. "),
			...Array.from({ length: 5 }, () => tok(SENTENCE)), // batch #2 (clean)
			tok(BAD_SENTENCE), // starts batch #3
			...Array.from({ length: 3 }, () => tok(SENTENCE)),
			...Array.from({ length: 4 }, () => tok(SENTENCE)), // tail of batch #3 + all of batch #4
		];
		const events = await drain(screenOutputStream(src(tokens), { screen }));
		expect(streamedText(events)).toBe("Hi. " + SENTENCE.repeat(5));
		expect(streamedText(events)).not.toContain("BAD");
		expect(finalOf(events)?.text).toContain(OUTPUT_CONTENT_TRUNCATE);
	});

	it("abort discards an accumulating pendingBatch too (not just the raw buffer)", async () => {
		const ctrl = new AbortController();
		const screen = vi.fn(async () => clean);
		async function* aborting(): AsyncGenerator<MessageUpdate> {
			yield tok("Hi. "); // first batch — released
			yield tok("One clean sentence that is not long enough to flush on its own. "); // accumulates
			ctrl.abort();
			yield tok("Never screened either. ");
		}
		const events = await drain(screenOutputStream(aborting(), { screen, signal: ctrl.signal }));
		expect(streamedText(events)).toBe("Hi. ");
		expect(streamedText(events)).not.toContain("clean sentence");
		expect(finalOf(events)?.interrupted).toBe(true);
	});
});

// ── coop-review-plane Step 3c: the output-review ledger + terminal boundary ──────────────────────────
describe("screenOutputStream — output ledger + stopped boundary", () => {
	const newLedger = (over: Partial<OutputScreenLedger> = {}): OutputScreenLedger => ({
		dispatched: [],
		stopped: false,
		released: "",
		...over,
	});

	it("records EVERY batch on the ledger (texts), tracks released text, and flags released entries", async () => {
		const screen = vi.fn(async () => clean);
		const ledger = newLedger();
		const events = await drain(
			screenOutputStream(src([tok("One. "), tok("Two. "), tok("Three.")]), { screen, ledger })
		);
		const dispatchedText = ledger.dispatched.map((d) => d.text).join("");
		expect(dispatchedText).toContain("One.");
		expect(dispatchedText).toContain("Three.");
		expect(ledger.released).toBe(streamedText(events)); // release context for the report
		// Every released batch is flagged released, so the finalizer never re-appends it to the report.
		expect(
			ledger.dispatched
				.filter((d) => d.released)
				.map((d) => d.text)
				.join("")
		).toBe(ledger.released);
	});

	it("a BLOCKED batch is recorded but NOT flagged released (so the report can include it)", async () => {
		const screen = vi.fn(async (t: string) => (t.includes("BAD") ? blockContent : clean));
		const ledger = newLedger();
		await drain(screenOutputStream(src([tok("Safe. "), tok("BAD.")]), { screen, ledger }));
		const bad = ledger.dispatched.find((d) => d.text.includes("BAD"));
		expect(bad?.released).toBe(false); // blocked → not released → reportable
		const safe = ledger.dispatched.find((d) => d.text.includes("Safe"));
		expect(safe?.released).toBe(true);
	});

	it("a PRE-stopped ledger screens nothing and releases nothing (terminal boundary)", async () => {
		const screen = vi.fn(async () => clean);
		const ledger = newLedger({ stopped: true });
		const events = await drain(screenOutputStream(src([tok("One. "), tok("Two.")]), { screen, ledger }));
		expect(screen).not.toHaveBeenCalled();
		expect(ledger.dispatched.length).toBe(0);
		expect(streamedText(events)).toBe("");
	});

	it("stopping mid-stream releases nothing further — a verdict that settles during finalization is not released", async () => {
		const ledger = newLedger();
		const screen = vi.fn(async () => {
			ledger.stopped = true; // the route's finalizer flips this while a screen is in flight
			return clean;
		});
		const events = await drain(screenOutputStream(src([tok("First. "), tok("Second.")]), { screen, ledger }));
		// The first batch's verdict settles into a stopped ledger → the consume loop breaks before release.
		expect(streamedText(events)).toBe("");
	});

	it("the final REMAINDER goes through dispatch — a remainder-only answer with a hit is dispatched and blocked", async () => {
		const ledger = newLedger();
		const screen = vi.fn(async () => blockContent);
		const events = await drain(screenOutputStream(src([tok("no terminal punctuation here")]), { screen, ledger }));
		expect(ledger.dispatched.length).toBe(1); // the remainder was recorded
		expect(screen).toHaveBeenCalledTimes(1);
		expect(streamedText(events)).toBe(""); // blocked → nothing released
		expect(finalOf(events)?.text).toBe(OUTPUT_CONTENT_DECLINE);
	});

	it("the outputModeration marker never carries the raw rule key (client shape unchanged)", async () => {
		let marker: OutputModerationMarker | undefined;
		const screen = vi.fn(async () => blockNamed); // category chat-block-violence
		const ledger = newLedger();
		await drain(screenOutputStream(src([tok("Bad. ")]), { screen, ledger, onModeration: (m) => (marker = m) }));
		expect(JSON.stringify(marker)).not.toContain("chat-block-violence"); // raw key never surfaces
		expect(marker?.ruleLabel).toBe("Violent content"); // curated label may
	});

	// Two rules share "Support needed" (and three "Respectful communication"), so the label alone can't
	// say which rule cut an answer. The server log names it, for calibrating rules.json (CUR-2320).
	it("names the rule that blocked in the server's per-answer screen log, and no rule when nothing blocked", async () => {
		const info = vi.spyOn(logger, "info");
		const ruleOf = () =>
			info.mock.calls
				.filter(([, msg]) => msg === "[moderation] output screen timing")
				.map(([fields]) => (fields as { rule?: string }).rule);

		await drain(screenOutputStream(src([tok("Bad. ")]), { screen: vi.fn(async () => blockNamed), ledger: newLedger() }));
		expect(ruleOf()).toEqual(["chat-block-violence"]);

		info.mockClear();
		await drain(screenOutputStream(src([tok("Fine. ")]), { screen: vi.fn(async () => clean), ledger: newLedger() }));
		expect(ruleOf()).toEqual([undefined]);
		info.mockRestore();
	});
});

// The route rebuilds the withheld bubble from these out-of-band fields — `text` alone is discarded by the
// downstream honesty layer (the CUR-946 empty-bubble bug), so the carriers are the real contract.
describe("screenOutputStream — out-of-band decline/notice carriers (CUR-946)", () => {
	// The resolved per-rule message: rules.json's sentence plus the who-set-this-limit line (CUR-3205).
	const RULE_MSG = resolveActionMessage("chat-block-violence");

	it("full content block carries declineText (the decline copy), and no declineNotice", async () => {
		const screen = vi.fn(async () => blockContent);
		const final = finalOf(await drain(screenOutputStream(src([tok("Bad first. ")]), { screen })));
		expect(final?.declineText).toBe(OUTPUT_CONTENT_DECLINE);
		expect(final?.declineNotice).toBeUndefined();
	});

	it("full child block carries the child decline copy on declineText", async () => {
		const screen = vi.fn(async () => blockChild);
		const final = finalOf(await drain(screenOutputStream(src([tok("Bad. ")]), { screen })));
		expect(final?.declineText).toBe(OUTPUT_CHILD_SAFETY_DECLINE);
		expect(final?.declineNotice).toBeUndefined();
	});

	it("mid-stream content block carries the truncate notice on declineNotice (and no declineText)", async () => {
		const screen = vi.fn(async (t: string) => (t.includes("BAD") ? blockContent : clean));
		const final = finalOf(
			await drain(screenOutputStream(src([tok("Fine. "), tok("BAD next.")]), { screen }))
		);
		expect(final?.declineNotice).toBe(OUTPUT_CONTENT_TRUNCATE);
		expect(final?.declineText).toBeUndefined();
	});

	it("mid-stream child block carries the child truncate notice on declineNotice", async () => {
		const screen = vi.fn(async (t: string) => (t.includes("BAD") ? blockChild : clean));
		const final = finalOf(
			await drain(screenOutputStream(src([tok("Fine. "), tok("BAD next.")]), { screen }))
		);
		expect(final?.declineNotice).toBe(OUTPUT_CHILD_SAFETY_TRUNCATE);
		expect(final?.declineText).toBeUndefined();
	});

	it("a per-rule rules.json message overrides the generic copy on BOTH carriers", async () => {
		// Full block → declineText is the per-rule message, not the generic decline.
		const fullFinal = finalOf(
			await drain(screenOutputStream(src([tok("Bad. ")]), { screen: vi.fn(async () => blockNamed) }))
		);
		expect(fullFinal?.declineText).toBe(RULE_MSG);

		// Mid-stream → declineNotice is the same per-rule message, not the generic truncate notice.
		const midFinal = finalOf(
			await drain(
				screenOutputStream(src([tok("Fine. "), tok("BAD next.")]), {
					screen: vi.fn(async (t: string) => (t.includes("BAD") ? blockNamed : clean)),
				})
			)
		);
		expect(midFinal?.declineNotice).toBe(RULE_MSG);
	});
});

// A source that never finishes on its own but closes the moment the stream abandons it, as a cancelled
// fetch stream does. A bare generator parked on a never-settling await cannot be closed, so every test
// that used one sat out the whole CLEANUP_DEADLINE_MS (2s, screenStream.ts:91) after its assertions
// were already decided.
function closable(gen: AsyncGenerator<MessageUpdate>): AsyncIterable<MessageUpdate> {
	let close!: () => void;
	const closed = new Promise<IteratorReturnResult<undefined>>(
		(resolve) => (close = () => resolve({ done: true, value: undefined }))
	);
	return {
		[Symbol.asyncIterator]: () => ({
			next: () => Promise.race([gen.next(), closed]),
			return: async () => {
				close();
				return { done: true, value: undefined };
			},
		}),
	};
}

describe("screenOutputStream — phase deadline (CUR-1657)", () => {
	// PHASE_DEADLINE_MS is a module-level const read from OUTPUT_SCREEN_PHASE_TIMEOUT_MS at import time, so a
	// real (small) value via a fresh module instance is simpler here than fighting fake-timer/microtask
	// interleaving against a 25s default — this keeps the test genuinely fast without asserting on the
	// production default's exact number.
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});
	async function freshModule(windowMs = 40) {
		vi.stubEnv("OUTPUT_SCREEN_PHASE_TIMEOUT_MS", String(windowMs));
		vi.resetModules();
		return import("./screenStream");
	}

	// Simulates the exact symptom CUR-1657 measured: a screen call (or the upstream source) that never
	// settles, for whatever reason the per-call bound didn't catch — the phase deadline is the backstop
	// independent of why.
	it("nothing released yet: an honest, non-safety decline — not silence until the outer watchdog", async () => {
		const mod = await freshModule();
		async function* hangingSrc(): AsyncGenerator<MessageUpdate> {
			yield tok("Hello there. ");
			await new Promise(() => {}); // upstream never reaches done
		}
		const screen = vi.fn(() => new Promise<OutputScreenResult>(() => {})); // never settles
		let marker: OutputModerationMarker | undefined;
		const events = await drain(
			mod.screenOutputStream(closable(hangingSrc()), { screen, onModeration: (m) => (marker = m) })
		);

		const declineText =
			"I started to answer, but couldn't finish verifying the response in time, so I've held it back. Please try again.";
		expect(streamedText(events)).toBe("");
		expect(finalOf(events)?.text).toBe(declineText);
		expect(finalOf(events)?.declineText).toBe(declineText);
		expect(finalOf(events)?.declineNotice).toBeUndefined();
		// Not a moderation flag — no verdict was ever reached, so this must not read as one.
		expect(marker).toMatchObject({ flagged: false, screened: false });
		// A model did start this answer, so it is not a fixed reply (CUR-1872 marks only the no-token case).
		expect(events.some((e) => e.type === MessageUpdateType.FixedReply)).toBe(false);
	});

	// The sovereignty-shed case — the upstream source hangs with NO token ever arriving, so
	// `screen` is never even called. Distinct from the test above, where "Hello there. " DOES arrive and
	// DOES reach `screen` (it just never resolves) — that case still honestly says "I started to
	// answer." This one must not. (CUR-1727)
	it("no token ever arrived: the no-tokens decline, not the started-to-answer one", async () => {
		const mod = await freshModule();
		// eslint-disable-next-line require-yield -- deliberately never yields, to prove screenCount alone can't distinguish this from a pending-but-dispatched screen
		async function* hangingEmptySrc(): AsyncGenerator<MessageUpdate> {
			await new Promise(() => {}); // upstream never yields a single token or event
		}
		const screen = vi.fn(() => new Promise<OutputScreenResult>(() => {}));
		let marker: OutputModerationMarker | undefined;
		const events = await drain(
			mod.screenOutputStream(closable(hangingEmptySrc()), {
				screen,
				preTokenDeadlineMs: 40,
				onModeration: (m) => (marker = m),
			})
		);

		const declineText = "Alpha is at capacity right now. Please try again in a moment.";
		expect(screen).not.toHaveBeenCalled();
		expect(streamedText(events)).toBe("");
		expect(finalOf(events)?.text).toBe(declineText);
		expect(finalOf(events)?.declineText).toBe(declineText);
		expect(marker).toMatchObject({ flagged: false, screened: false });
	});

	// That notice is server copy, and without a marker the receipt classed it as a model answer
	// "from training". The marker has to arrive BEFORE the FinalAnswer, which is when the client and the
	// route's persist both act on the reply. (CUR-1872)
	it("no token ever arrived: marks the reply as a fixed capacity notice before the FinalAnswer", async () => {
		const mod = await freshModule();
		// eslint-disable-next-line require-yield -- deliberately never yields, same as the case above
		async function* hangingEmptySrc(): AsyncGenerator<MessageUpdate> {
			await new Promise(() => {});
		}
		const screen = vi.fn(() => new Promise<OutputScreenResult>(() => {}));
		const events = await drain(
			mod.screenOutputStream(closable(hangingEmptySrc()), { screen, preTokenDeadlineMs: 40 })
		);

		const fixedAt = events.findIndex((e) => e.type === MessageUpdateType.FixedReply);
		const finalAt = events.findIndex((e) => e.type === MessageUpdateType.FinalAnswer);
		expect(events[fixedAt]).toEqual({ type: MessageUpdateType.FixedReply, kind: "capacity" });
		expect(finalAt).toBeGreaterThan(fixedAt);
	});

	it("preTokenDeadlineMs bounds the wait for a first token (the output_screen_timeout fault)", async () => {
		const mod = await freshModule(60_000);
		// eslint-disable-next-line require-yield -- deliberately never yields
		async function* hangingEmptySrc(): AsyncGenerator<MessageUpdate> {
			await new Promise(() => {});
		}
		const screen = vi.fn(() => new Promise<OutputScreenResult>(() => {}));
		const started = Date.now();
		const events = await drain(
			mod.screenOutputStream(closable(hangingEmptySrc()), { screen, preTokenDeadlineMs: 40 })
		);
		expect(finalOf(events)?.text).toBe("Alpha is at capacity right now. Please try again in a moment.");
		// Well under the 60s module deadline: the override, not the env value, ended the phase.
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	// Counted from the start of the phase, a 25s window declines a slow model's turns before their first
	// token (CUR-2243). A slow first token is the route watchdogs'
	// business; the idle window opens when the model starts answering.
	it("a first token later than the window is released, not declined (the window opens at the first token)", async () => {
		const mod = await freshModule(100);
		async function* slowStartSrc(): AsyncGenerator<MessageUpdate> {
			await new Promise((r) => setTimeout(r, 300)); // three windows with no token at all
			yield tok("Bern is the capital. ");
			yield fin("Bern is the capital. ");
		}
		const timings: TurnSpans = {} as TurnSpans;
		const screen = vi.fn(async () => clean);
		const events = await drain(mod.screenOutputStream(slowStartSrc(), { screen, timings }));

		expect(streamedText(events)).toBe("Bern is the capital. ");
		expect(finalOf(events)?.text).not.toMatch(/at capacity|couldn't finish verifying/i);
		// The wait before the window opened is recorded on its own, so screenPhaseMs can be read net of it.
		expect(timings.screenPreTokenWaitMs).toBeGreaterThanOrEqual(250);
		expect(timings.screenPhaseMs).toBeGreaterThanOrEqual(timings.screenPreTokenWaitMs!);
	});

	it("with no first token, nothing here declines: the turn ends only when the route aborts it", async () => {
		const mod = await freshModule(40);
		// eslint-disable-next-line require-yield -- deliberately never yields
		async function* hangingEmptySrc(): AsyncGenerator<MessageUpdate> {
			await new Promise(() => {});
		}
		const ctrl = new AbortController();
		setTimeout(() => ctrl.abort(), 200); // the route's silence watchdog, at five windows
		const screen = vi.fn(() => new Promise<OutputScreenResult>(() => {}));
		const events = await drain(
			mod.screenOutputStream(closable(hangingEmptySrc()), { screen, signal: ctrl.signal })
		);
		// The stream outlived five windows and ended only on the abort. A wall-clock bound here would be
		// flaky on a loaded runner, because the timer can fire early by Date.now() (CUR-2945).
		expect(ctrl.signal.aborted).toBe(true);
		expect(finalOf(events)?.text ?? "").not.toMatch(/at capacity|couldn't finish verifying/i);
		expect(events.some((e) => e.type === MessageUpdateType.FixedReply)).toBe(false);
	});

	it("a cleared prefix already released: keeps it, appends the timeout notice (not the safety one)", async () => {
		const mod = await freshModule();
		async function* hangingSrc(): AsyncGenerator<MessageUpdate> {
			yield tok("Safe one. ");
			yield tok("Stuck two. ");
			await new Promise(() => {}); // upstream never reaches done
		}
		// Only the opening batch clears; anything dispatched later hangs forever, same as a stuck Nth Coop call.
		const screen = vi.fn((text: string) =>
			text.includes("Safe") ? Promise.resolve(clean) : new Promise<OutputScreenResult>(() => {})
		);
		const events = await drain(mod.screenOutputStream(closable(hangingSrc()), { screen }));

		const truncateNotice = "_[The rest of this response couldn't be verified in time and was withheld.]_";
		expect(streamedText(events)).toBe("Safe one. ");
		expect(finalOf(events)?.text).toBe(`Safe one.\n\n${truncateNotice}`);
		expect(finalOf(events)?.declineNotice).toBe(truncateNotice);
		expect(finalOf(events)?.text).not.toContain(OUTPUT_CONTENT_TRUNCATE);
	});

	// The deadline bounds the gap between releases, not the whole answer. A slow model's
	// healthy answer can take over a minute, and a whole-phase bound would cut it.
	// Window 200ms, one paragraph every 60ms for 480ms: finishes only if every release re-arms it. (CUR-1884)
	it("a slow but steady answer that outlasts the window streams in full (the window is an idle bound)", async () => {
		const mod = await freshModule(200);
		// Each paragraph is past MIN_CHUNK_CHARS (250), so every one is its own batch and its own release.
		const para = (n: number) => `Paragraph ${n}. ${"word ".repeat(55)}end.\n\n`;
		const paras = Array.from({ length: 8 }, (_, i) => para(i + 1));
		async function* steadySrc(): AsyncGenerator<MessageUpdate> {
			for (const p of paras) {
				await new Promise((r) => setTimeout(r, 60));
				yield tok(p);
			}
			yield fin(paras.join(""));
		}
		const screen = vi.fn(async () => clean);
		const events = await drain(mod.screenOutputStream(steadySrc(), { screen }));

		expect(streamedText(events).trimEnd()).toBe(paras.join("").trimEnd());
		expect(finalOf(events)?.declineNotice).toBeUndefined();
		expect(finalOf(events)?.text).not.toContain("couldn't be verified in time");
	});

	it("a stall after progress still trips the window, measured from the last release", async () => {
		const mod = await freshModule(200);
		async function* stallSrc(): AsyncGenerator<MessageUpdate> {
			for (let i = 1; i <= 4; i++) {
				await new Promise((r) => setTimeout(r, 60));
				yield tok(`Paragraph ${i}. ${"word ".repeat(55)}end.\n\n`);
			}
			await new Promise(() => {}); // upstream goes silent and never finishes
		}
		const screen = vi.fn(async () => clean);
		const started = performance.now();
		const events = await drain(mod.screenOutputStream(closable(stallSrc()), { screen }));
		const elapsed = performance.now() - started;

		const truncateNotice = "_[The rest of this response couldn't be verified in time and was withheld.]_";
		expect(streamedText(events)).toContain("Paragraph 4.");
		expect(finalOf(events)?.declineNotice).toBe(truncateNotice);
		// Last release lands near 240ms and the window runs 200ms from there. A trip under 400ms means it
		// was counted from the start of the phase.
		expect(elapsed).toBeGreaterThan(400);
	});

	it("does not fire on a turn that finishes well inside the deadline", async () => {
		const mod = await freshModule();
		const screen = vi.fn(async () => clean);
		const events = await drain(
			mod.screenOutputStream(src([tok("One. "), tok("Two."), fin("One. Two.")]), { screen })
		);

		expect(streamedText(events)).toBe("One. Two.");
		expect(finalOf(events)?.text).toBe("One. Two.");
	});
});

// textGeneration merges the title generator into the stream it hands this function, so a new
// conversation's Title event can arrive seconds after the model's own FinalAnswer. The answer's tail must
// not wait for it, or a short answer's last sentence is held behind a slow title call. (CUR-1907)
describe("screenOutputStream — the answer does not wait for the title (CUR-1907)", () => {
	const title = (t: string): MessageUpdate => ({ type: MessageUpdateType.Title, title: t }) as MessageUpdate;

	it("finalizes the answer before a late title arrives, then still passes the title through", async () => {
		let releaseTitle!: () => void;
		const titleGate = new Promise<void>((r) => (releaseTitle = r));
		async function* source(): AsyncGenerator<MessageUpdate> {
			yield tok("Paris is the capital.");
			yield fin("Paris is the capital.");
			await titleGate; // the title call, still in flight after the model finished
			yield title("Capital of France");
		}
		const gen = screenOutputStream(source(), { screen: vi.fn(async () => clean) });
		const seen: MessageUpdate[] = [];
		for (;;) {
			const r = await gen.next();
			if (r.done) break;
			seen.push(r.value);
			if (r.value.type === MessageUpdateType.FinalAnswer) break;
		}
		expect(finalOf(seen)?.text, "the answer finalized while the title was still pending").toBe("Paris is the capital.");
		releaseTitle();
		const rest = await drain(gen);
		expect(rest.map((e) => e.type)).toContain(MessageUpdateType.Title);
	});

	it("cancels a pending title when the turn is aborted after the answer, rather than waiting on it", async () => {
		const ctrl = new AbortController();
		async function* source(): AsyncGenerator<MessageUpdate> {
			yield tok("Short.");
			yield fin("Short.");
			await new Promise(() => {}); // a title call that never settles
		}
		const gen = screenOutputStream(closable(source()), {
			screen: vi.fn(async () => clean),
			signal: ctrl.signal,
		});
		for (;;) {
			const r = await gen.next();
			if (r.done || r.value.type === MessageUpdateType.FinalAnswer) break;
		}
		ctrl.abort();
		const rest = await drain(gen); // before the fix's abort handling this never returns and the test times out
		expect(rest.filter((e) => e.type === MessageUpdateType.Title)).toEqual([]);
		expect((await gen.next()).done).toBe(true);
	});
});

// CUR-2316. When the primary lane stalls and the turn moves to the backup, the backup has to get a full
// idle window of its own, not whatever the silent primary left of it.
describe("screenOutputStream — a lane switch re-arms the phase deadline (CUR-2316)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("a backup that answers inside its own window after a failover is released, not replaced by the at-capacity notice", async () => {
		vi.stubEnv("OUTPUT_SCREEN_PHASE_TIMEOUT_MS", "100");
		vi.resetModules();
		const mod = await import("./screenStream");
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
		async function* switchedSrc(): AsyncGenerator<MessageUpdate> {
			await sleep(70); // the silent primary spends most of the window
			yield {
				type: MessageUpdateType.Failover,
				from: "swiss-ai/apertus-v1.5-70b",
				to: "zai-org/GLM-5.3",
				reason: "unavailable",
			} as MessageUpdate;
			await sleep(70); // the backup's first sentence lands 140ms in: past the original window only
			yield tok("Bern. ");
		}
		const screen = vi.fn(() => Promise.resolve(clean));
		const events = await drain(mod.screenOutputStream(switchedSrc(), { screen }));
		expect(streamedText(events)).toBe("Bern. ");
		expect(finalOf(events)?.text).not.toMatch(/at capacity/i);
	});
});

// CUR-546. An agent turn works for longer than the phase window with no text, pulsing a non-content
// keepalive every 4s (endpointAgent.ts HEARTBEAT_MS). On agent turns those keepalives count as progress
// while no screen is in flight, so a turn that is working is not declined as a stuck one.
describe("screenOutputStream — agent keepalives re-arm the phase deadline (CUR-546)", () => {
	// Fake timers: on real ones a host stall landing inside a 30 ms keepalive sleep lets the
	// 60 ms window expire first, which makes the test fail under load (CUR-2638).
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.resetModules();
	});
	// Advances the fake clock in small steps until the stream ends, so every timer fires in due order.
	async function drainOnClock(gen: AsyncGenerator<MessageUpdate>) {
		let done = false;
		const events = drain(gen).finally(() => (done = true));
		while (!done) await vi.advanceTimersByTimeAsync(5);
		return events;
	}

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const keepalive = {
		type: MessageUpdateType.RouterMetadata,
		route: "",
		model: "",
	} as MessageUpdate;
	// Says it is starting, then works silently for 3× the window pulsing a keepalive at half the
	// window, then answers. The window opens at the first token (CUR-2243), so the silence has to
	// come after one for the keepalives to matter.
	async function* workingAgentSrc(): AsyncGenerator<MessageUpdate> {
		yield tok("Starting on it. ");
		for (let i = 0; i < 6; i++) {
			await sleep(30);
			yield keepalive;
		}
		yield tok("The file is written. ");
	}
	async function fresh() {
		vi.stubEnv("OUTPUT_SCREEN_PHASE_TIMEOUT_MS", "60");
		vi.resetModules();
		return import("./screenStream");
	}

	it("releases the answer of an agent turn that worked silently past the window while pulsing keepalives", async () => {
		const mod = await fresh();
		const screen = vi.fn(() => Promise.resolve(clean));
		const events = await drainOnClock(
			mod.screenOutputStream(workingAgentSrc(), { screen, rearmOnProgress: true })
		);
		expect(streamedText(events)).toBe("Starting on it. The file is written. ");
		expect(finalOf(events)?.text).not.toMatch(/couldn't finish verifying|at capacity/i);
	});

	it("without the agent option, the same keepalives do not re-arm, so ordinary turns keep the CUR-1657 backstop", async () => {
		const mod = await fresh();
		const screen = vi.fn(() => Promise.resolve(clean));
		const events = await drainOnClock(mod.screenOutputStream(workingAgentSrc(), { screen }));
		expect(streamedText(events)).toBe("Starting on it. ");
		expect(finalOf(events)?.text).toMatch(/couldn't be verified in time/i);
	});

	it("still declines when a screen never settles, even while keepalives keep arriving", async () => {
		const mod = await fresh();
		async function* stuckScreenSrc(): AsyncGenerator<MessageUpdate> {
			yield tok("Starting on it. ");
			for (;;) {
				await sleep(20);
				yield keepalive;
			}
		}
		const screen = vi.fn(() => new Promise<OutputScreenResult>(() => {}));
		const events = await drainOnClock(
			mod.screenOutputStream(stuckScreenSrc(), { screen, rearmOnProgress: true })
		);
		expect(streamedText(events)).toBe("");
		expect(finalOf(events)?.text).toMatch(/couldn't finish verifying/i);
	});
});

// CUR-2343. A held-back answer was still served by a model, and the footer has to be able to say
// which. The endpoint emits the served model with its first chunk, so it sits in the pass-through
// queue by the time the phase deadline trips, and has to leave with the decline.
describe("screenOutputStream — a phase-deadline decline keeps the served model (CUR-2343)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("passes the router metadata through when the screen never settles", async () => {
		vi.stubEnv("OUTPUT_SCREEN_PHASE_TIMEOUT_MS", "60");
		vi.resetModules();
		const mod = await import("./screenStream");
		async function* servedSrc(): AsyncGenerator<MessageUpdate> {
			yield {
				type: MessageUpdateType.RouterMetadata,
				route: "",
				model: "swiss-ai/apertus-v1.5-70b",
			} as MessageUpdate;
			yield tok("Starting on it. ");
		}
		const screen = vi.fn(() => new Promise<OutputScreenResult>(() => {}));
		const events = await drain(mod.screenOutputStream(servedSrc(), { screen }));
		expect(finalOf(events)?.text).toMatch(/couldn't finish verifying/i);
		expect(
			events.filter((e) => e.type === MessageUpdateType.RouterMetadata).map((e) => e.model)
		).toEqual(["swiss-ai/apertus-v1.5-70b"]);
	});
});

// CUR-3847. A read-aloud clip is synthesized from the model's whole answer, so it carries text the
// screen has not cleared. It reaches the visitor only once the screen has cleared that answer, after
// its text, and never on a decline, a truncation, or a phase-deadline notice.
describe("screenOutputStream — a read-aloud clip waits for the answer's verdict (CUR-3847)", () => {
	const clip: MessageUpdate = {
		type: MessageUpdateType.Mcp,
		tool: "speak",
		space: "tts",
		audio: "https://example.org/clip.wav",
	};
	const clipsIn = (events: MessageUpdate[]) =>
		events.filter((e) => e.type === MessageUpdateType.Mcp && Boolean(e.audio));
	const slow = (r: OutputScreenResult) => vi.fn(async () => (await new Promise((t) => setTimeout(t, 30)), r));

	for (const [order, events] of [
		["the clip after the answer (speak-all)", [fin("A declined answer."), clip]],
		["the clip before the answer", [clip, fin("A declined answer.")]],
	] as const) {
		it(`drops the clip of a declined answer, with ${order}`, async () => {
			const out = await drain(screenOutputStream(src([...events]), { screen: slow(blockContent) }));
			expect(finalOf(out)?.text).toBe(OUTPUT_CONTENT_DECLINE);
			expect(clipsIn(out), "a clip of the declined answer reached the client").toEqual([]);
		});
	}

	it("drops the clip when the screen cuts the answer partway (the clip would read the cut tail)", async () => {
		let n = 0;
		const screen = vi.fn(async () => (n++ === 0 ? clean : blockContent));
		const long = "First sentence is fine. ".repeat(40);
		const out = await drain(
			screenOutputStream(src([tok(long), tok("Then the bad part."), fin(long + "Then the bad part."), clip]), {
				screen,
			})
		);
		expect(finalOf(out)?.declineNotice).toBe(OUTPUT_CONTENT_TRUNCATE);
		expect(clipsIn(out)).toEqual([]);
	});

	it("releases the clip of a cleared answer, after the answer's text", async () => {
		const out = await drain(screenOutputStream(src([clip, fin("Paris is the capital.")]), { screen: slow(clean) }));
		expect(clipsIn(out)).toEqual([clip]);
		const types = out.map((e) => e.type);
		expect(types.indexOf(MessageUpdateType.Mcp)).toBeGreaterThan(types.indexOf(MessageUpdateType.FinalAnswer));
	});

	it("still passes a clip that arrives after a cleared answer has finalized", async () => {
		let releaseClip!: () => void;
		const gate = new Promise<void>((r) => (releaseClip = r));
		async function* source(): AsyncGenerator<MessageUpdate> {
			yield fin("Paris is the capital.");
			await gate; // synthesis still running after the model finished
			yield clip;
		}
		const gen = screenOutputStream(source(), { screen: vi.fn(async () => clean) });
		const seen: MessageUpdate[] = [];
		for (;;) {
			const r = await gen.next();
			if (r.done) break;
			seen.push(r.value);
			if (r.value.type === MessageUpdateType.FinalAnswer) break;
		}
		releaseClip();
		expect(clipsIn([...seen, ...(await drain(gen))])).toEqual([clip]);
	});

	it("does not hold an Mcp update that carries no audio (a skipped tool still shows promptly)", async () => {
		const skipped: MessageUpdate = { type: MessageUpdateType.Mcp, tool: "", skipped: true, skipMs: 9000 };
		const out = await drain(screenOutputStream(src([skipped, fin("Answer.")]), { screen: slow(clean) }));
		const types = out.map((e) => e.type);
		expect(types.indexOf(MessageUpdateType.Mcp)).toBeLessThan(types.indexOf(MessageUpdateType.FinalAnswer));
	});
});
