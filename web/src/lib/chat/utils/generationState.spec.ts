import { describe, expect, test } from "vitest";

import type { Message } from "$lib/chat/types/Message";
import {
	MessageUpdateStatus,
	MessageUpdateType,
	type MessageUpdate,
} from "$lib/chat/types/MessageUpdate";
import {
	agentRunReattachDeadline,
	agentRunToReattach,
	classifyWatchdogFire,
	deriveMessageStatus,
	GENERATION_STALE_MS,
	handedOffAgentRun,
	isAssistantGenerationTerminal,
	isConversationGenerationActive,
	isGenerationStale,
	isTurnStillRunning,
	reattachView,
	serverSnapshotHasAnswer,
	shouldShowEmptyAnswerNotice,
	shouldSyncMessagesFromData,
	showsProvenanceReceipt,
	stoppedTurnMissingFromSnapshot,
} from "./generationState";
import { MAX_TRACK_DURATION_MS } from "$lib/chat/stores/backgroundGenerations.svelte";
import { AGENT_RUN_CEILING_MS } from "./deadlineLadder";

function assistantMessage(overrides: Partial<Message> = {}): Message {
	return {
		from: "assistant",
		id: "assistant-1" as Message["id"],
		content: "",
		children: [],
		...overrides,
	};
}

describe("generationState", () => {
	test("returns active when assistant has no terminal update", () => {
		const messages = [
			assistantMessage({
				updates: [{ type: MessageUpdateType.Stream, token: "Hello" }],
			}),
		];

		expect(isConversationGenerationActive(messages)).toBe(true);
	});

	test("treats final answer update as terminal", () => {
		const message = assistantMessage({
			updates: [{ type: MessageUpdateType.FinalAnswer, text: "Done", interrupted: false }],
		});

		expect(isAssistantGenerationTerminal(message)).toBe(true);
		expect(isConversationGenerationActive([message])).toBe(false);
	});

	test("treats error status update as terminal", () => {
		const message = assistantMessage({
			updates: [
				{
					type: MessageUpdateType.Status,
					status: MessageUpdateStatus.Error,
					message: "Something went wrong",
				},
			],
		});

		expect(isAssistantGenerationTerminal(message)).toBe(true);
		expect(isConversationGenerationActive([message])).toBe(false);
	});

	test("treats finished status update as terminal", () => {
		const message = assistantMessage({
			updates: [
				{
					type: MessageUpdateType.Status,
					status: MessageUpdateStatus.Finished,
				},
			],
		});

		expect(isAssistantGenerationTerminal(message)).toBe(true);
		expect(isConversationGenerationActive([message])).toBe(false);
	});

	test("treats interrupted assistant message as terminal", () => {
		const message = assistantMessage({
			interrupted: true,
			updates: [{ type: MessageUpdateType.Stream, token: "partial" }],
		});

		expect(isAssistantGenerationTerminal(message)).toBe(true);
		expect(isConversationGenerationActive([message])).toBe(false);
	});
});

describe("deriveMessageStatus", () => {
	test("running while no terminal update has arrived", () => {
		expect(
			deriveMessageStatus(
				assistantMessage({ updates: [{ type: MessageUpdateType.Stream, token: "Hel" }] })
			)
		).toBe("running");
	});

	test("complete on a clean final answer", () => {
		expect(
			deriveMessageStatus(
				assistantMessage({
					updates: [{ type: MessageUpdateType.FinalAnswer, text: "Done", interrupted: false }],
				})
			)
		).toBe("complete");
	});

	test("error wins on an error status", () => {
		expect(
			deriveMessageStatus(
				assistantMessage({
					updates: [
						{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Error, message: "boom" },
					],
				})
			)
		).toBe("error");
	});

	test("incomplete on the persisted interrupted flag (with partial content preserved)", () => {
		expect(
			deriveMessageStatus(
				assistantMessage({
					interrupted: true,
					content: "partial answer the user already saw",
					updates: [{ type: MessageUpdateType.Stream, token: "partial" }],
				})
			)
		).toBe("incomplete");
	});

	test("incomplete on a final-answer flagged interrupted", () => {
		expect(
			deriveMessageStatus(
				assistantMessage({
					updates: [{ type: MessageUpdateType.FinalAnswer, text: "cut off", interrupted: true }],
				})
			)
		).toBe("incomplete");
	});

	test("error takes precedence over interrupted when both are present", () => {
		expect(
			deriveMessageStatus(
				assistantMessage({
					interrupted: true,
					updates: [
						{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Error, message: "boom" },
					],
				})
			)
		).toBe("error");
	});

	test("non-assistant messages are always complete", () => {
		expect(deriveMessageStatus({ from: "user", id: "u1" as Message["id"], content: "hi" })).toBe(
			"complete"
		);
	});
});

// ChatMessage's `isProcessStreaming` used bare `!loading` to decide when to stop rendering
// the reasoning panel as still-in-progress. `loading` settles a beat before the final content lands
// in `message.updates` (same race as CUR-708 below) — the header flipped to "Computed" while the
// body still held the streamed placeholder, until reload. These pin the composition that fixes it. (CUR-903)
describe("isTurnStillRunning", () => {
	test("true while the client fetch is in flight, regardless of message state", () => {
		expect(isTurnStillRunning(true, undefined)).toBe(true);
		expect(
			isTurnStillRunning(
				true,
				assistantMessage({
					updates: [{ type: MessageUpdateType.FinalAnswer, text: "Done", interrupted: false }],
				})
			)
		).toBe(true);
	});

	test("true once loading has settled but no terminal update has landed yet (THE REGRESSION)", () => {
		expect(
			isTurnStillRunning(
				false,
				assistantMessage({ updates: [{ type: MessageUpdateType.Stream, token: "Working on it" }] })
			)
		).toBe(true);
	});

	test("false once both the fetch has settled and the message reached a terminal state", () => {
		expect(
			isTurnStillRunning(
				false,
				assistantMessage({
					updates: [{ type: MessageUpdateType.FinalAnswer, text: "Done", interrupted: false }],
				})
			)
		).toBe(false);
	});
});

// The same race as the block above, on the surface that carries the one claim this
// product rests on. The provenance receipt must not render on bare `!loading`: in the window
// where the fetch has settled and the final content has not landed, the receipt's `{:else}` branch
// would render "No provenance for this answer — nothing reported which model served it." over a turn
// that is still being served, then swap to the full provenance line when it finishes.
describe("showsProvenanceReceipt", () => {
	const streaming = assistantMessage({
		updates: [{ type: MessageUpdateType.Stream, token: "The capital of Japan" }],
	});
	const finished = assistantMessage({
		updates: [{ type: MessageUpdateType.FinalAnswer, text: "Tokyo.", interrupted: false }],
	});

	test("withholds the receipt while the fetch has settled but no terminal update has landed (THE DEFECT)", () => {
		expect(showsProvenanceReceipt({ message: streaming, loading: false })).toBe(false);
	});

	test("withholds the receipt while the fetch is still in flight", () => {
		expect(showsProvenanceReceipt({ message: streaming, loading: true })).toBe(false);
		expect(showsProvenanceReceipt({ message: finished, loading: true })).toBe(false);
	});

	test("shows the receipt once the fetch settled AND the turn reached a terminal state", () => {
		expect(showsProvenanceReceipt({ message: finished, loading: false })).toBe(true);
	});

	test("never shows it for a cache-served turn, finished or not — that turn ran no live pipeline", () => {
		expect(
			showsProvenanceReceipt({
				message: assistantMessage({ ...finished, servedFromCache: true }),
				loading: false,
			})
		).toBe(false);
	});

	test("never shows it on a user turn", () => {
		expect(
			showsProvenanceReceipt({
				message: { from: "user", id: "u1" as Message["id"], content: "hi", children: [] },
				loading: false,
			})
		).toBe(false);
	});
});

describe("isGenerationStale", () => {
	test("a recent write is not stale", () => {
		expect(isGenerationStale(new Date())).toBe(false);
		expect(isGenerationStale(new Date(Date.now() - GENERATION_STALE_MS + 5_000))).toBe(false);
	});

	test("a write older than the threshold is stale", () => {
		expect(isGenerationStale(new Date(Date.now() - GENERATION_STALE_MS - 1_000))).toBe(true);
	});

	test("accepts ISO strings (API payloads)", () => {
		expect(
			isGenerationStale(new Date(Date.now() - GENERATION_STALE_MS - 1_000).toISOString())
		).toBe(true);
		expect(isGenerationStale(new Date().toISOString())).toBe(false);
	});

	test("missing or invalid timestamps are never stale", () => {
		expect(isGenerationStale(undefined)).toBe(false);
		expect(isGenerationStale("not-a-date")).toBe(false);
	});

	// Load-bearing invariant: a platform-killed generation (no persisted terminal update) must be
	// flagged stale BEFORE the client poller evicts its background-generation entry, otherwise the
	// "dead generation" signal never reaches the UI and the spinner hangs forever (the cold-lane
	// 503 → infinite-spinner failure). Asserted as a RELATIONSHIP, not against today's numbers, so
	// it survives the next time the ladder moves. Full ordering: deadlineLadder.spec.ts.
	test("staleness fires before the background poller evicts (no infinite spinner)", () => {
		expect(GENERATION_STALE_MS).toBeLessThan(MAX_TRACK_DURATION_MS);
	});
});

// The conversation page's data-driven resync guard. Pins the decision that closes cross-turn spillage: a
// conversation invalidate delivering while a locally-written turn holds the sync must NOT swap `messages`
// (it would orphan the live stream's write target and paint the previous turn's answer under the new
// prompt). The page passes `localTurnSyncHold` tracked, so releasing the hold re-runs the effect — these
// tables pin the pure decision at each state.
// CUR-1660. This is the one question `cacheFallbackHere` cannot answer, and the reason the veto
// above could not tell "the server never got this turn" from "the server has a finished answer you
// were never shown". Each case below is a state the real page reaches.
describe("serverSnapshotHasAnswer", () => {
	test("true for a finished assistant turn with words in it", () => {
		expect(
			serverSnapshotHasAnswer([
				assistantMessage({
					content: "Bern is the capital of Switzerland.",
					updates: [{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished }],
				}),
			])
		).toBe(true);
	});

	test("false for an empty snapshot — the state the cache-fallback veto exists to guard", () => {
		expect(serverSnapshotHasAnswer([])).toBe(false);
		expect(serverSnapshotHasAnswer(undefined)).toBe(false);
	});

	test("false for a turn still generating, however long it has been going", () => {
		expect(
			serverSnapshotHasAnswer([
				assistantMessage({
					content: "partial",
					updates: [{ type: MessageUpdateType.Stream, token: "partial" }],
				}),
			])
		).toBe(false);
	});

	// Stricter than isAssistantGenerationTerminal on purpose: it answers true for both of these, which
	// is right for "is it still generating?" and wrong for "does the server have something better than
	// what is on screen?". Lifting the veto for either would wipe the painted turn for nothing.
	test("false for a finished turn whose body is empty", () => {
		expect(
			serverSnapshotHasAnswer([
				assistantMessage({
					content: "   ",
					updates: [{ type: MessageUpdateType.FinalAnswer, text: "", interrupted: false }],
				}),
			])
		).toBe(false);
	});

	// The sharp one, and the reason `interrupted` is checked here rather than left to
	// isAssistantGenerationTerminal: a stopped or cut turn IS terminal and CAN carry real partial
	// content, so a naive "terminal and non-empty" would lift the veto in favour of a truncated
	// answer — replacing a painted turn with a worse one, which is the failure this veto exists for.
	test("false for an INTERRUPTED turn even when it carries real partial content", () => {
		expect(
			serverSnapshotHasAnswer([
				assistantMessage({
					interrupted: true,
					content: "Bern is the capital city of Switzer",
					updates: [
						{ type: MessageUpdateType.FinalAnswer, text: "Bern is the capital city of Switzer", interrupted: true },
					],
				}),
			]),
			"a truncated answer was allowed to lift the veto and overwrite the turn already on screen"
		).toBe(false);
	});

	test("false when the conversation holds no assistant turn at all", () => {
		expect(
			serverSnapshotHasAnswer([
				{ from: "user", id: "u1" as Message["id"], content: "hello", children: [] },
			])
		).toBe(false);
	});

	test("reads the LAST assistant turn, not the first", () => {
		const answered = assistantMessage({
			id: "assistant-2" as Message["id"],
			content: "Bern.",
			updates: [{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished }],
		});
		const stillRunning = assistantMessage({
			id: "assistant-3" as Message["id"],
			content: "",
			updates: [{ type: MessageUpdateType.Stream, token: "" }],
		});
		expect(serverSnapshotHasAnswer([answered, stillRunning])).toBe(false);
		expect(serverSnapshotHasAnswer([stillRunning, answered])).toBe(true);
	});
});

describe("shouldSyncMessagesFromData", () => {
	const base = {
		convChanged: false,
		dataChanged: false,
		localTurnSyncHold: false,
		cacheFallbackHere: false,
		snapshotHasAnswer: false,
		reportActionPending: false,
	};

	test("vetoes a data refresh while a local turn holds the sync (the spillage case)", () => {
		// Covers the whole turn — including post-first-token, where the old `pending` guard
		// had already lapsed, and the stop/terminal-persist window, where writeMessageInFlight
		// had already been cleared.
		expect(shouldSyncMessagesFromData({ ...base, dataChanged: true, localTurnSyncHold: true })).toBe(
			false
		);
	});

	test("applies a data refresh once the hold is released", () => {
		expect(shouldSyncMessagesFromData({ ...base, dataChanged: true })).toBe(true);
	});

	test("a conversation change always syncs — navigation must paint the destination", () => {
		expect(
			shouldSyncMessagesFromData({
				...base,
				convChanged: true,
				localTurnSyncHold: true,
				cacheFallbackHere: true,
			})
		).toBe(true);
	});

	test("vetoes a data refresh while a client-only cache fallback is painted AND the server has nothing", () => {
		// The name carries `AND the server has nothing` on purpose. What the veto guards is an empty
		// snapshot replacing a painted turn; the fallback flag is only how the page notices. A test
		// named for the flag alone passes forever and says nothing about which state it pinned.
		expect(shouldSyncMessagesFromData({ ...base, dataChanged: true, cacheFallbackHere: true })).toBe(
			false
		);
	});

	// The client aborts 8.0s after the server's keepalives stop and paints the connection-lost
	// message, while the server finishes and persists the real answer anyway. With the veto
	// unconditional the page would keep showing "<model> is working…" over
	// an answer a reload renders at once (CUR-1660).
	test("lifts the cache-fallback veto once the snapshot actually carries a finished answer", () => {
		expect(
			shouldSyncMessagesFromData({
				...base,
				dataChanged: true,
				cacheFallbackHere: true,
				snapshotHasAnswer: true,
			}),
			"a server snapshot holding a real answer was refused, so a turn the server completed stays invisible"
		).toBe(true);
	});

	test("an answer-bearing snapshot does NOT override the other two vetoes", () => {
		// The lift is scoped to the cache-fallback veto alone. The spillage hold and the report hold
		// guard hazards a finished answer says nothing about — swapping `messages` under a live
		// stream's write target, and re-minting ids under a ReportButton mid-submission.
		expect(
			shouldSyncMessagesFromData({
				...base,
				dataChanged: true,
				snapshotHasAnswer: true,
				localTurnSyncHold: true,
			})
		).toBe(false);
		expect(
			shouldSyncMessagesFromData({
				...base,
				dataChanged: true,
				snapshotHasAnswer: true,
				reportActionPending: true,
			})
		).toBe(false);
	});

	// The resync re-mints message ids, which would destroy and re-create a ReportButton
	// mid-submission and silently discard its acknowledgement. See reportHold.ts. (CUR-1583)
	test("vetoes a data refresh while a report submission is on screen", () => {
		expect(
			shouldSyncMessagesFromData({ ...base, dataChanged: true, reportActionPending: true })
		).toBe(false);
	});

	test("a conversation change always syncs even mid-report — navigation must paint the destination", () => {
		expect(
			shouldSyncMessagesFromData({
				...base,
				convChanged: true,
				reportActionPending: true,
			})
		).toBe(true);
	});

	test("no identity change and no conversation change → no-op regardless of flags", () => {
		expect(shouldSyncMessagesFromData(base)).toBe(false);
		expect(shouldSyncMessagesFromData({ ...base, localTurnSyncHold: true })).toBe(false);
		expect(shouldSyncMessagesFromData({ ...base, cacheFallbackHere: true })).toBe(false);
		expect(shouldSyncMessagesFromData({ ...base, reportActionPending: true })).toBe(false);
	});
});

// The tab-hang case. Once content has started streaming, the watchdog's fire handler must
// not bail out unconditionally (`if (firstContentSeen || isAborted) return`) — a dead connection past that
// point would produce no outcome at all, so the tab would sit on "Working on it" forever even after the server
// finished and persisted a complete answer. These tests pin the contract: firing after content has
// streamed must return an ACTIONABLE outcome, not silence.
describe("classifyWatchdogFire", () => {
	test("fires a stall-recovery outcome even after content has already streamed (THE REGRESSION)", () => {
		// The watchdog must stay armed once real content arrives, so a connection that dies
		// afterward is visible to the client. This assertion must never become unreachable.
		expect(classifyWatchdogFire({ firstContentSeen: true, isAborted: false })).toBe(
			"stall-recovery"
		);
	});

	test("still an early failure when nothing has rendered yet (unchanged pre-existing behavior)", () => {
		expect(classifyWatchdogFire({ firstContentSeen: false, isAborted: false })).toBe(
			"early-failure"
		);
	});

	test("ignores a fire that races a turn already ended by another path (user stop / navigation)", () => {
		expect(classifyWatchdogFire({ firstContentSeen: false, isAborted: true })).toBe("ignore");
		expect(classifyWatchdogFire({ firstContentSeen: true, isAborted: true })).toBe("ignore");
	});
});

// The gate on "No answer was produced for this message." Named for the CONTRACT, not the return
// value: every one of these says which turns may be told they produced nothing, because a test
// called "returns false while running" would still pass if the notice never rendered at all.
describe("shouldShowEmptyAnswerNotice", () => {
	test("stays silent on a turn that is still running with nothing rendered yet", () => {
		// `loading` goes false when the fetch settles, before the final content is applied to
		// blocks; the message's own state machine still says running. Without this gate every turn
		// wears the notice for a second or more and then answers normally, so the chat calls live
		// turns failures in front of first-time visitors.
		expect(
			shouldShowEmptyAnswerNotice({
				message: assistantMessage({
					updates: [{ type: MessageUpdateType.Stream, token: "" }],
				}),
				noAnswer: true,
				loading: false,
			})
		).toBe(false);
	});

	test("still fires on a FINISHED turn whose whole output was reasoning (CUR-113)", () => {
		// The failure the notice was built for must survive the fix above: a terminal turn that left
		// the user a blank bubble still has to say so.
		expect(
			shouldShowEmptyAnswerNotice({
				message: assistantMessage({
					updates: [
						{ type: MessageUpdateType.FinalAnswer, text: "", interrupted: false },
					] as Message["updates"],
				}),
				noAnswer: true,
				loading: false,
			})
		).toBe(true);
	});

	test("stays silent while the stream is live, even with nothing rendered", () => {
		expect(
			shouldShowEmptyAnswerNotice({
				message: assistantMessage({ updates: [] }),
				noAnswer: true,
				loading: true,
			})
		).toBe(false);
	});

	test("stays silent on a finished turn that DID produce an answer", () => {
		expect(
			shouldShowEmptyAnswerNotice({
				message: assistantMessage({
					updates: [
						{ type: MessageUpdateType.FinalAnswer, text: "hello", interrupted: false },
					] as Message["updates"],
				}),
				noAnswer: false,
				loading: false,
			})
		).toBe(false);
	});

	test("defers to the error surface rather than stacking on top of it", () => {
		expect(
			shouldShowEmptyAnswerNotice({
				message: assistantMessage({
					updates: [
						{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Error, message: "boom" },
					] as Message["updates"],
				}),
				noAnswer: true,
				loading: false,
			})
		).toBe(false);
	});

	test("fires on an interrupted turn that produced nothing at all", () => {
		// Interrupted-with-partial-content is the other notice's job; interrupted-with-NOTHING is
		// this one's, and the two are mutually exclusive by construction in ChatMessage.
		expect(
			shouldShowEmptyAnswerNotice({
				message: assistantMessage({ interrupted: true, updates: [] }),
				noAnswer: true,
				loading: false,
			})
		).toBe(true);
	});
});

describe("agentRunToReattach (CUR-993)", () => {
	const answer = (over: Partial<Message>): Message =>
		({ id: "a", from: "assistant", content: "Stopped early.", ...over }) as Message;
	const question = { id: "q", from: "user", content: "run it" } as Message;

	test("picks up an interrupted agent answer whose task is still open", () => {
		const last = answer({ interrupted: true, agentRun: { taskId: "t1" } });
		expect(agentRunToReattach([question, last])).toBe(last);
	});

	test("leaves alone an answer that finished, has no task, or whose task is closed", () => {
		for (const last of [
			answer({ agentRun: { taskId: "t1" } }),
			answer({ interrupted: true }),
			answer({ interrupted: true, agentRun: { taskId: "t1", closed: true } }),
		]) {
			expect(agentRunToReattach([question, last])).toBeUndefined();
		}
	});

	test("only the answer at the end of the thread: an older interrupted run is not resumed under a newer turn", () => {
		const older = answer({ interrupted: true, agentRun: { taskId: "t1" } });
		expect(agentRunToReattach([question, older, { ...question, id: "q2" }])).toBeUndefined();
	});
});

describe("reattachView (CUR-3875)", () => {
	const shown = { content: "Paragraph one.\n\nParagraph two." };
	const stream = { type: MessageUpdateType.Stream, token: "Paragraph one." } as MessageUpdate;
	const interruptedEnd = {
		type: MessageUpdateType.FinalAnswer,
		text: "Paragraph one.",
		interrupted: true,
	} as MessageUpdate;
	const errorEnd = {
		type: MessageUpdateType.Status,
		status: MessageUpdateStatus.Error,
		message: "timed out",
	} as MessageUpdate;

	test("keeps the shown answer on screen while the replay is shorter than it", () => {
		expect(reattachView(shown, { content: "Paragraph one.", updates: [stream] }, "streaming")).toBeUndefined();
		expect(reattachView(shown, { content: "", updates: [] }, "streaming")).toBeUndefined();
	});

	test("takes over once the replay has caught up, still running: nothing that ends the turn comes with it", () => {
		const replay = {
			content: "Paragraph one.\n\nParagraph two.\n\nThree.",
			updates: [stream, interruptedEnd, errorEnd],
			interrupted: true,
		};
		expect(reattachView(shown, replay, "streaming")).toEqual({
			content: replay.content,
			updates: [stream],
			interrupted: false,
		});
	});

	test("a real answer replaces what was shown as it stands, even when shorter", () => {
		const done = { type: MessageUpdateType.FinalAnswer, text: "Short." } as MessageUpdate;
		expect(reattachView(shown, { content: "Short.", updates: [done] }, "final")).toEqual({
			content: "Short.",
			updates: [done],
			interrupted: undefined,
		});
	});

	test("giving up never shows less than was on screen, and carries the interrupted ending", () => {
		const view = reattachView(
			shown,
			{ content: "Paragraph one.", updates: [stream, interruptedEnd], interrupted: true },
			"gave-up"
		);
		expect(view).toEqual({ content: shown.content, updates: [stream, interruptedEnd], interrupted: true });
		expect(deriveMessageStatus({ ...assistantMessage(), ...view })).toBe("incomplete");
	});
});

describe("agentRunReattachDeadline (CUR-3875)", () => {
	test("counts the run's ceiling from when its answer was first written, not from now", () => {
		const createdAt = new Date("2026-10-12T20:00:00Z");
		expect(agentRunReattachDeadline({ createdAt }, Date.parse("2026-10-12T20:02:00Z"))).toBe(
			createdAt.getTime() + AGENT_RUN_CEILING_MS
		);
	});

	test("reads a serialized timestamp, and counts from now when there is none", () => {
		expect(agentRunReattachDeadline({ createdAt: "2026-10-12T20:00:00Z" as unknown as Date }, 0)).toBe(
			Date.parse("2026-10-12T20:00:00Z") + AGENT_RUN_CEILING_MS
		);
		expect(agentRunReattachDeadline({}, 1_000)).toBe(1_000 + AGENT_RUN_CEILING_MS);
	});
});

describe("handedOffAgentRun", () => {
	const run = { type: MessageUpdateType.AgentRun, taskId: "t1" } as MessageUpdate;
	const interruptedEnd = { type: MessageUpdateType.FinalAnswer, text: "", interrupted: true } as MessageUpdate;
	const cleanEnd = { type: MessageUpdateType.FinalAnswer, text: "done", interrupted: false } as MessageUpdate;
	const error = { type: MessageUpdateType.Status, status: MessageUpdateStatus.Error, message: "x" } as MessageUpdate;

	test("an answer stored interrupted with its run still open is a handoff the page follows", () => {
		expect(handedOffAgentRun([run, interruptedEnd])).toBe(true);
	});

	test("a finished run, a closed run, an errored turn and an ordinary turn are not", () => {
		expect(handedOffAgentRun([run, cleanEnd])).toBe(false);
		expect(handedOffAgentRun([run, { ...run, closed: true } as MessageUpdate, interruptedEnd])).toBe(false);
		expect(handedOffAgentRun([run, interruptedEnd, error])).toBe(false);
		expect(handedOffAgentRun([interruptedEnd])).toBe(false);
		expect(handedOffAgentRun(undefined)).toBe(false);
	});
});

describe("stoppedTurnMissingFromSnapshot (CUR-3018)", () => {
	const question = { from: "user", id: "user-1", content: "q", children: [] } as unknown as Message;

	test("keeps the local turn when a Stop before any reply reads back a snapshot without the question", () => {
		expect(
			stoppedTurnMissingFromSnapshot({
				firstContentSeen: false,
				turnMessageId: "user-1",
				snapshot: [],
			})
		).toBe(true);
	});

	test("lets the refresh apply once the server's copy holds the question", () => {
		expect(
			stoppedTurnMissingFromSnapshot({
				firstContentSeen: false,
				turnMessageId: "user-1",
				snapshot: [question, assistantMessage({ interrupted: true })],
			})
		).toBe(false);
	});

	test("leaves a Stop after content arrived to the ordinary refresh", () => {
		expect(
			stoppedTurnMissingFromSnapshot({ firstContentSeen: true, turnMessageId: "user-1", snapshot: [] })
		).toBe(false);
	});

	test("does not veto when no snapshot could be read or the turn has no id", () => {
		expect(
			stoppedTurnMissingFromSnapshot({
				firstContentSeen: false,
				turnMessageId: "user-1",
				snapshot: undefined,
			})
		).toBe(false);
		expect(
			stoppedTurnMissingFromSnapshot({ firstContentSeen: false, turnMessageId: undefined, snapshot: [] })
		).toBe(false);
	});
});
