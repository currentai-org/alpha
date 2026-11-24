// Checks docs/guides/scan-gates.machine.json, the content-scan gates every upload and chat turn passes,
// against the code that decides them. Two halves:
//   1. The machine itself: XState accepts it, every state reaches an end, every transition names its
//      site, what decides it and whether production can take it, and every cited file exists.
//   2. Each transition with a `probe` is driven through the real exported function under the config
//      the machine names, and must land where the machine says. Adding a probe to the machine without
//      one here, or one here without the machine, fails.
// The judge is injected wherever Shieldstral would answer, so these pin the code around the model,
// never what the model says about a real picture.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMachine } from "xstate";
import sharp from "sharp";
import { ObjectId } from "bson";
import { screenRendition } from "$lib/chat/server/screenRendition";
import type { JudgeFn, JudgeOutcome, PreparedImage } from "$lib/chat/server/guardScreenTypes";

const MACHINE_PATH = fileURLToPath(new URL("../../../../../../docs/guides/scan-gates.machine.json", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("../../../../", import.meta.url));

type Meta = Record<string, unknown>;
type StateConfig = { type?: string; meta?: Meta; states?: Record<string, StateConfig> };
type MachineConfig = StateConfig & { id: string; initial: string; $comment?: string };
type Edge = { source: string; target: string; event: string; meta: Meta };

const config = JSON.parse(readFileSync(MACHINE_PATH, "utf8")) as MachineConfig;

/** The ticket-lifecycle check's own flattener (web/scripts/ticket-lifecycle-check.mjs). Loaded by URL so
 *  the type check does not pull that script and its untyped helpers into the app's program. */
type FlatGraph = {
	nodes: Map<string, { id: string; parent: string | null; leaf: boolean; final: boolean }>;
	edges: Edge[];
};
const LIFECYCLE_CHECK = new URL("../../../../../scripts/ticket-lifecycle-check.mjs", import.meta.url).href;
const { graphOf } = (await import(/* @vite-ignore */ LIFECYCLE_CHECK)) as { graphOf: (c: unknown) => FlatGraph };

/** The ticket-lifecycle check's own flattener, so this machine is read the way that one is. Ids come
 *  back rooted at the machine id; the prefix is dropped here so a state reads as `chat.typeCheck`. */
function flatten(root: MachineConfig) {
	const graph = graphOf(root);
	const local = (id: string) => (id === root.id ? "" : id.slice(root.id.length + 1));
	const nodes = [...graph.nodes.values()].filter((n) => n.id !== root.id);
	const edges: Edge[] = graph.edges.map((e) => ({ ...e, source: local(e.source), target: local(e.target) }));
	const stateMeta = (path: string): Meta => {
		let c: StateConfig = root;
		for (const part of path.split(".")) c = c.states![part];
		return c.meta ?? {};
	};
	return {
		edges,
		stateMeta,
		finals: nodes.filter((n) => n.final).map((n) => local(n.id)),
		leaves: nodes.filter((n) => n.leaf).map((n) => local(n.id)),
		start: root.initial,
	};
}

function reachableFrom(start: string, edges: Edge[]): Set<string> {
	const seen = new Set([start]);
	const queue = [start];
	while (queue.length) {
		const at = queue.shift()!;
		for (const e of edges) {
			if (e.source !== at || seen.has(e.target)) continue;
			seen.add(e.target);
			queue.push(e.target);
		}
	}
	return seen;
}

const g = flatten(config);

describe("scan-gates machine — its structure", () => {
	it("is a config XState accepts, so every target names a real state", () => {
		const { $comment: _c, ...machine } = config;
		expect(() => createMachine(machine as never)).not.toThrow();
	});

	it("every state is reachable from received, and every non-final state has a way to an end", () => {
		const fromStart = reachableFrom(g.start, g.edges);
		expect(g.leaves.filter((l) => !fromStart.has(l))).toEqual([]);
		const stuck = g.leaves.filter((l) => !g.finals.some((f) => reachableFrom(l, g.edges).has(f)));
		expect(stuck).toEqual([]);
	});

	it("every transition names its site, what decides it, and whether production can take it", () => {
		const missing = g.edges.filter(
			(e) =>
				typeof e.meta.site !== "string" ||
				typeof e.meta.decidedBy !== "string" ||
				!["reachable", "unreachable"].includes(e.meta.prod as string) ||
				typeof e.meta.prodWhy !== "string" ||
				!("probe" in e.meta)
		);
		expect(missing.map((e) => `${e.source} ${e.event}`)).toEqual([]);
	});

	it("every end says what the visitor sees and which screens read the pixels", () => {
		const bad = g.finals.filter((f) => {
			const m = g.stateMeta(f);
			return typeof m.visitor !== "string" || !Array.isArray(m.screens);
		});
		expect(bad).toEqual([]);
	});

	it("every cited site is a file under web/src that has the cited line", () => {
		const broken: string[] = [];
		for (const e of g.edges) {
			const [file, line] = (e.meta.site as string).split(":");
			const abs = `${SRC_DIR}${file}`;
			if (!existsSync(abs)) broken.push(`${e.source} ${e.event}: ${file} does not exist`);
			else if (Number(line) > readFileSync(abs, "utf8").split("\n").length)
				broken.push(`${e.source} ${e.event}: ${file} is shorter than line ${line}`);
		}
		expect(broken).toEqual([]);
	});
});

describe("scan-gates machine — what production can reach", () => {
	const prodEdges = g.edges.filter((e) => e.meta.prod === "reachable");
	const prodEnds = [...reachableFrom(g.start, prodEdges)].filter((s) => g.finals.includes(s));

	it("in production no chat or My files picture is hash-checked: every hash transition is unreachable", () => {
		const hashEdges = g.edges.filter((e) => /^HASH_/.test(e.event));
		expect(hashEdges.length).toBeGreaterThan(0);
		expect(hashEdges.filter((e) => e.meta.prod === "reachable")).toEqual([]);
		// The only way production reaches the chat hash refusal is through a hash match, so it is not reached.
		expect(prodEnds).not.toContain("chat.refusedMatch");
	});

	it("in production a chat picture and a My files picture can each end screened by Shieldstral's child-tier rules", () => {
		expect(prodEnds).toContain("turnScreen.declinedChild");
		expect(prodEnds).toContain("myFiles.quarantined");
		expect(prodEnds).toContain("myFiles.screenedStored");
	});

	it("in production the pictures kept with no screen at all are exactly: agent-made files, turn pictures past the cap of eight, and chat pictures whose screen could not answer", () => {
		// A chat picture is stored before its turn is screened (chat.stored), so every turn ending keeps
		// it; the ones listed here never had a screen answer on their pixels.
		const keptUnscreened = prodEnds.filter((f) => {
			const m = g.stateMeta(f);
			return (m.screens as string[]).length === 0 && /stored|leftOutOverCap|declinedUnscreened/i.test(f) && f !== "myFiles.stored";
		});
		expect(keptUnscreened.sort()).toEqual(
			["agentFile.storedUnscreened", "turnScreen.declinedUnscreened", "turnScreen.leftOutOverCap"].sort()
		);
	});
});

// ── probes: each drives the real code into the transition that names it ─────────────────────────────

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const no: JudgeOutcome = { answer: { kind: "score", score: 0.01, yes: false }, httpOk: true, servedModel: "m" };
const yes: JudgeOutcome = { answer: { kind: "score", score: 0.99, yes: true }, httpOk: true, servedModel: "m" };
const unknown: JudgeOutcome = { answer: { kind: "unknown" }, httpOk: false };

async function png(i: number): Promise<Buffer> {
	return sharp({ create: { width: 8, height: 8, channels: 3, background: { r: i % 256, g: (i * 7) % 256, b: 40 } } })
		.png()
		.toBuffer();
}

async function ruleQuery(key: string): Promise<string> {
	const { loadGuardPolicy } = await import("$lib/chat/server/guardPolicy");
	const rule = loadGuardPolicy()!.entries.find((r) => r.key === key);
	if (!rule) throw new Error(`no rule ${key}`);
	return rule.query;
}

/** A judge that answers per query, and records which unit kinds it saw. */
function judging(answer: (query: string) => JudgeOutcome) {
	const kinds: string[] = [];
	const queries: string[] = [];
	const judge: JudgeFn = async (target, query) => {
		kinds.push(target.kind);
		queries.push(query);
		return answer(query);
	};
	return { judge, kinds, queries };
}

/** One image unit as the turn prepares it: the screen rendition is the real one (screenRendition.ts). */
async function imageUnit(i = 1): Promise<PreparedImage> {
	const source = await png(i);
	const screenB64 = (await screenRendition(sharp, source)).toString("base64");
	return { sha: `sha-${i}`, mime: "image/png", source, screenB64, sourceMessageId: "", caption: "" };
}

const pictureOnly = (images: PreparedImage[]) => ({ corpus: "", typedTurnText: "", images, failedUnits: [] });

/** The csamScan config, mocked per probe, as csamScan.spec.ts does. */
async function withScanConfig(cfg: Record<string, string>) {
	vi.doMock("$lib/chat/server/config", () => ({ config: cfg }));
	vi.doMock("$lib/chat/server/logger", () => ({ logger: quiet }));
	return {
		csam: await import("./csamScan"),
		embedded: await import("./embeddedImageScan"),
	};
}

const PROBES: Record<string, () => Promise<void>> = {
	"hash.none-takes-the-file": async () => {
		const { csam, embedded } = await withScanConfig({});
		expect(csam.csamScanAllowsUploads()).toBe(true);
		await expect(embedded.scanFileForCsam(new Blob([new Uint8Array(await png(1))]), "a.png", "image")).resolves.toEqual({
			status: "unscanned",
			reason: "no-scanner",
		});
	},
	"hash.incomplete-refuses": async () => {
		const { csam } = await withScanConfig({ CSAM_SCAN_PROVIDER: "hma" });
		expect(csam.csamScanAllowsUploads()).toBe(false);
		await expect(csam.scanCsamHash(new Blob(["x"]), "a.png")).rejects.toBeInstanceOf(csam.CsamScannerUnconfiguredError);
	},
	"hash.ready-clean": async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
		const { csam } = await withScanConfig({ CSAM_SCAN_BASE_URL: "https://scanner.example.test" });
		await expect(csam.scanCsamHash(new Blob(["x"]), "a.png")).resolves.toEqual({ status: "clean" });
	},
	"hash.ready-match": async () => {
		const hit = { pdq: { BANK: [{ bank_content_id: 1, distance: "0" }] } };
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(hit), { status: 200 })));
		const { csam } = await withScanConfig({ CSAM_SCAN_BASE_URL: "https://scanner.example.test" });
		await expect(csam.scanCsamHash(new Blob(["x"]), "a.png")).resolves.toMatchObject({ status: "match", bankContentId: 1 });
	},
	"hash.ready-unreachable": async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
		const { csam } = await withScanConfig({ CSAM_SCAN_BASE_URL: "https://scanner.example.test" });
		await expect(csam.scanCsamHash(new Blob(["x"]), "a.png", { retryDelayMs: 0 })).rejects.toBeInstanceOf(
			csam.CsamScannerUnreachableError
		);
	},
	"embedded.text-has-no-pixels": async () => {
		const { embedded } = await withScanConfig({ CSAM_SCAN_BASE_URL: "https://scanner.example.test" });
		const scan = vi.fn();
		expect(embedded.scanTargetForMime("text/plain")).toBeNull();
		expect(embedded.scanTargetForMime("image/png")).toBe("image");
		await expect(embedded.scanFileForCsam(new Blob(["hello"]), "a.txt", null, { scan })).resolves.toEqual({ status: "clean" });
		expect(scan).not.toHaveBeenCalled();
	},

	"stored.no-pictures-no-call": async () => {
		const { screenStoredImages } = await import("./uploadImageGuard");
		const { judge, queries } = judging(() => no);
		await expect(screenStoredImages([], { judge, logger: quiet })).resolves.toBeUndefined();
		expect(queries).toEqual([]);
	},
	"stored.selfhost-unconfigured-stores": async () => {
		vi.stubEnv("GUARD_SHADOW_URL", "");
		vi.stubEnv("ALPHA_EDITION", "selfhost");
		const { screenStoredImages } = await import("./uploadImageGuard");
		await expect(screenStoredImages([await png(2)], { logger: quiet })).resolves.toBeUndefined();
	},
	"stored.hosted-unconfigured-refuses": async () => {
		vi.stubEnv("GUARD_SHADOW_URL", "");
		vi.stubEnv("ALPHA_EDITION", "hosted");
		const { screenStoredImages, ImageScreenUnavailableError } = await import("./uploadImageGuard");
		await expect(screenStoredImages([await png(3)], { logger: quiet })).rejects.toBeInstanceOf(ImageScreenUnavailableError);
	},
	"stored.too-many-refuses": async () => {
		const { screenStoredImages, TooManyImagesToScreenError } = await import("./uploadImageGuard");
		const many = await Promise.all(Array.from({ length: 21 }, (_, i) => png(i + 10)));
		await expect(screenStoredImages(many, { judge: judging(() => no).judge, logger: quiet })).rejects.toBeInstanceOf(
			TooManyImagesToScreenError
		);
	},
	"stored.child-hit-refuses": async () => {
		const { screenStoredImages, ImageScreenBlockedError } = await import("./uploadImageGuard");
		const csam = await ruleQuery("chat-block-child-sexual-content");
		const grooming = await ruleQuery("chat-block-child-grooming");
		const { judge, queries } = judging((q) => (q === csam ? yes : no));
		const err = await screenStoredImages([await png(4)], { judge, logger: quiet }).catch((e) => e);
		expect(err).toBeInstanceOf(ImageScreenBlockedError);
		expect(err.category).toBe("chat-block-child-sexual-content");
		// A stored picture is asked the two child-tier rules and nothing else, so adult sexual content
		// (chat-block-sexual) is not judged here.
		expect(new Set(queries)).toEqual(new Set([csam, grooming]));
	},
	"stored.unknown-refuses": async () => {
		const { screenStoredImages, ImageScreenUnavailableError } = await import("./uploadImageGuard");
		await expect(
			screenStoredImages([await png(5)], { judge: judging(() => unknown).judge, logger: quiet })
		).rejects.toBeInstanceOf(ImageScreenUnavailableError);
	},
	"stored.clear-stores": async () => {
		const { screenStoredImages } = await import("./uploadImageGuard");
		await expect(screenStoredImages([await png(6)], { judge: judging(() => no).judge, logger: quiet })).resolves.toBeUndefined();
	},

	"turn.image-cap-is-eight": async () => {
		const { prepareTurnMedia } = await import("$lib/chat/server/chat/prepareTurnMedia");
		const { MAX_TURN_IMAGES } = await import("$lib/chat/server/guardScreenTypes");
		const pics = await Promise.all(Array.from({ length: MAX_TURN_IMAGES + 1 }, (_, i) => png(i + 40)));
		const store = new Map(pics.map((p, i) => [`img${i}`, p]));
		const downloadFile = vi.fn(async (sha: string) => ({
			type: "base64" as const,
			name: sha,
			value: store.get(sha)!.toString("base64"),
			mime: "image/png",
		}));
		const files = [...store.keys()].map((sha) => ({ type: "hash" as const, value: sha, mime: "image/png", name: sha }));
		const prepared = await prepareTurnMedia([{ from: "user", id: "m1", content: "what are these?", files }], new ObjectId(), {
			downloadFile: downloadFile as never,
			logger: quiet,
		});
		expect(MAX_TURN_IMAGES).toBe(8);
		expect(prepared.screen.images).toHaveLength(8);
		expect(prepared.droppedImages).toBe(1);
		// The oldest occurrence is the one left out of the screen.
		expect(prepared.screen.images.map((i) => i.name)).not.toContain("img0");
	},
	"turn.failed-unit-closes": async () => {
		const { prepareTurnMedia } = await import("$lib/chat/server/chat/prepareTurnMedia");
		const { getGuardVerdict } = await import("$lib/chat/server/guardGate");
		const broken = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		const downloadFile = vi.fn(async () => ({ type: "base64" as const, name: "x", value: broken.toString("base64"), mime: "image/png" }));
		const prepared = await prepareTurnMedia(
			[{ from: "user", id: "m1", content: "", files: [{ type: "hash", value: "bad", mime: "image/png", name: "bad.png" }] }],
			new ObjectId(),
			{ downloadFile: downloadFile as never, logger: quiet }
		);
		expect(prepared.screen.failedUnits.map((u) => u.kind)).toEqual(["image-encode"]);
		const verdict = await getGuardVerdict(prepared.screen, { judge: judging(() => no).judge, logger: quiet });
		expect(verdict.childSafety).toEqual({ flagged: true, unscreened: true });
	},
	"turn.selfhost-without-screen": async () => {
		vi.stubEnv("GUARD_SHADOW_URL", "");
		vi.stubEnv("ALPHA_EDITION", "selfhost");
		const { selfHostWithoutScreen } = await import("$lib/chat/server/guardGate");
		expect(selfHostWithoutScreen(quiet)).toBe(true);
		vi.stubEnv("ALPHA_EDITION", "hosted");
		expect(selfHostWithoutScreen(quiet)).toBe(false);
	},
	"turn.no-shieldstral-closes": async () => {
		vi.stubEnv("GUARD_SHADOW_URL", "");
		const { getGuardVerdict } = await import("$lib/chat/server/guardGate");
		const verdict = await getGuardVerdict(pictureOnly([await imageUnit(7)]), { logger: quiet });
		expect(verdict.childSafety).toEqual({ flagged: true, unscreened: true });
		// The S1 text judge does not stand in for Shieldstral on a picture.
		const withS1 = await getGuardVerdict(pictureOnly([await imageUnit(7)]), { logger: quiet, s1: {} as never });
		expect(withS1.childSafety).toEqual({ flagged: true, unscreened: true });
	},
	"turn.child-hit-declines": async () => {
		const { getGuardVerdict } = await import("$lib/chat/server/guardGate");
		const csam = await ruleQuery("chat-block-child-sexual-content");
		const { judge, kinds } = judging((q) => (q === csam ? yes : no));
		const verdict = await getGuardVerdict(pictureOnly([await imageUnit(8)]), { judge, logger: quiet });
		expect(verdict.childSafety).toEqual({ flagged: true, category: "chat-block-child-sexual-content" });
		expect(new Set(kinds)).toEqual(new Set(["image"]));
	},
	"turn.content-hit-declines": async () => {
		const { getGuardVerdict } = await import("$lib/chat/server/guardGate");
		const sexual = await ruleQuery("chat-block-sexual");
		const verdict = await getGuardVerdict(pictureOnly([await imageUnit(9)]), {
			judge: judging((q) => (q === sexual ? yes : no)).judge,
			logger: quiet,
		});
		expect(verdict.childSafety.flagged).toBe(false);
		expect(verdict.contentPolicy).toEqual({ action: "block", category: "chat-block-sexual" });
	},
	"turn.unknown-closes": async () => {
		const { getGuardVerdict } = await import("$lib/chat/server/guardGate");
		const verdict = await getGuardVerdict(pictureOnly([await imageUnit(10)]), { judge: judging(() => unknown).judge, logger: quiet });
		expect(verdict.childSafety).toEqual({ flagged: true, unscreened: true });
	},
	"turn.clear-answers": async () => {
		const { getGuardVerdict } = await import("$lib/chat/server/guardGate");
		const verdict = await getGuardVerdict(pictureOnly([await imageUnit(11)]), { judge: judging(() => no).judge, logger: quiet });
		expect(verdict.childSafety).toEqual({ flagged: false });
		expect(verdict.contentPolicy).toEqual({ action: "allow" });
	},
};

describe("scan-gates machine — each probed transition, driven through the real code", () => {
	beforeEach(() => {
		vi.resetModules();
	});
	afterEach(() => {
		vi.doUnmock("$lib/chat/server/config");
		vi.doUnmock("$lib/chat/server/logger");
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	const named = [...new Set(g.edges.map((e) => e.meta.probe).filter((p): p is string => typeof p === "string"))].sort();

	it("the machine's probes and this file's probes are the same set", () => {
		expect(named).toEqual(Object.keys(PROBES).sort());
	});

	for (const probe of named) {
		const where = g.edges.filter((e) => e.meta.probe === probe).map((e) => `${e.source} ${e.event}`);
		it(`${probe} (${where.join(", ")})`, async () => {
			const run = PROBES[probe];
			expect(run, `no probe named ${probe}`).toBeDefined();
			await run();
		});
	}
});
