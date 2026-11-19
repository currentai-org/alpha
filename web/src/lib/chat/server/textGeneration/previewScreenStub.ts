// One Shieldstral GPU screens production, develop and every PR preview, and PR scenario
// suites account for most of its screened units. Each
// unit fans out to one call per rules.json category, so a burst of shards queues the GPU production
// screens through. A PR preview's scenario suite mostly checks our own UI, not the screen's verdicts,
// so a send carrying the fault-inject token and `x-e2e-screen: stub` gets a screen that allows
// everything here instead.
//
// The stub keeps the pipeline's shape: the output screen still chunks and holds each batch, for
// STUB_SCREEN_MS, so the release-timing specs (slow-answer-finishes, stop-keeps-what-was-shown) still
// exercise hold-and-release. Specs that read a verdict (a decline, or an everyday question the screen
// must not decline) are tagged `@real-screen` and send no stub header; see e2e/scenarios/helpers/test.ts.
//
// The develop host (siteDevelopHost) never stubs a plain `stub` send: its screen is the one people use. A develop
// build reached at its own deployment URL is where develop's push runs send their suite, and it stubs
// like any PR preview. A spec tagged `@stub-screen` sends `stub-tagged` instead, which the develop
// host honours. Those specs read no verdict (message-too-long's past-context answers) and would
// otherwise fail whenever the real screen has a fault. The token and the preview/development check
// still apply, so production never stubs either value.

import { DEPLOYMENT } from "$lib/deployment";
import type { GuardGateVerdict } from "$lib/chat/server/guardGate";
import type { OutputScreenResult } from "$lib/chat/server/moderation";
import { carriesFaultInjectToken } from "./faultInjection";
import { gitRef } from "$lib/server/runtimeEnv";

/** Roughly the time one Shieldstral call takes when the GPU is idle. */
const STUB_SCREEN_MS = 200;

/** The develop deployment people use (src/lib/deployment.ts). */
const DEVELOP_ALIAS_HOST = DEPLOYMENT.siteDevelopHost;

/** Whether this request asked for, and may have, the stub screen. Never throws; any miss is the
 *  real screen. */
export async function resolvePreviewScreenStub(
	req: Request,
	branch: string = gitRef() ?? ""
): Promise<boolean> {
	const asked = req.headers.get("x-e2e-screen");
	if (asked === "stub") {
		if (branch === "develop" && new URL(req.url).host === DEVELOP_ALIAS_HOST) return false;
	} else if (asked !== "stub-tagged") return false;
	return carriesFaultInjectToken(req);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The output screen's stand-in: allows every batch after STUB_SCREEN_MS. */
export async function stubOutputScreen(): Promise<OutputScreenResult> {
	await pause(STUB_SCREEN_MS);
	return { blocked: false, kind: null };
}

/** The input gate's stand-in for getGuardVerdict: an allow after STUB_SCREEN_MS, with no chunks
 *  screened, so its timing line shows `guardChunks: 0` for a stubbed turn. */
export async function stubGuardVerdict(): Promise<GuardGateVerdict> {
	await pause(STUB_SCREEN_MS);
	return {
		verdict: { status: "ok", actions: [] },
		childSafety: { flagged: false },
		contentPolicy: { action: "allow" },
		guardChunks: 0,
		guardTruncated: false,
		hits: [],
	};
}
