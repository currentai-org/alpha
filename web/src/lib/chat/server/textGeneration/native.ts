// The prompt of a turn whose model calls its own tools (harness.ts, `retrieval: "tools"`), and
// the base guards every prompt keeps. The turn that sends it is textGenerationWithoutTitle (index.ts):
// one turn for every plan, with the pipeline's pre-turn passes run only when the plan asks for them. (CUR-2420)

import { randomUUID } from "node:crypto";
import type { NativeToolKit } from "../endpoints/types";
import { nativeToolKit, type NativeGrounding } from "./nativeTools";
import { mcpServersKitForTurn, mcpToolsClause } from "$lib/chat/server/mcp/turnKit";
import { composeKits } from "$lib/chat/server/mcp/serversKit";
import { laneFeatureFacts, resolveFeatureFacts, servingClause } from "./persona";
import { GUARDS_ONLY_SECTIONS, type GuardsOnlyContext, NATIVE_SECTIONS, type NativeContext } from "./promptSections";
import { renderSections } from "./renderSections";
import { servingFor } from "$lib/chat/server/serving";
import { effectivePreprompt, type TurnPreferences } from "./turnPreferences";
import { extractLinkedUrl } from "../search/linkedUrl";
import { modelTakesImagesNow } from "$lib/chat/server/textOnly";
import { asksForTheLatest } from "$lib/chat/search/recency";
import { fetchLinkedPage } from "../search/openSearch";
import type { TextGenerationContext } from "./types";
import { loginEnabled } from "$lib/chat/server/oidcConfig";
import { dataExportEnabled } from "$lib/chat/server/dataPortability";
import { todayLine } from "./datetimeTool";
import { ensureFlagsPolled, flagEnabledOr } from "$lib/chat/server/flags";
import { resolveSpeakMode } from "$lib/chat/server/speak";
import { buildProvenanceFacts, previousServedRecord, provenanceFactsEnabled } from "./provenanceFacts";
import { laneModelIds } from "$lib/chat/server/endpoints/failover";
import { asksCalculateCounts } from "$lib/chat/server/harnessProfiles";
import { forcesWebSearch } from "../search/nativeSearchGate";
import { SEARCH_QUERY_LANGUAGE_FLAG } from "../search/queryLanguage";
import { readMessageLanguage } from "../declineCopy";
import { pastChatSearchOn } from "../pastChatSearchGate";

/**
 * The scaffolded turn's system prompt with the persona taken out and the base guards kept,
 * for the `persona: false` eval layer. Grounding, RAG and search evidence are appended after it as they
 * are after the persona, and the calculate clause stays when the turn offers the tool, so the arm
 * measures the persona and nothing else. (CUR-2331)
 */
export function guardsOnlyPrompt(opts: GuardsOnlyContext): string {
	return renderSections(GUARDS_ONLY_SECTIONS, opts);
}

/** The whole system prompt of a native turn, before the person's own custom prompt. Its sections, in
 *  order, are `NATIVE_SECTIONS` (promptSections.ts). */
export function nativeSystemPrompt(opts: NativeContext): string {
	return renderSections(NATIVE_SECTIONS, opts);
}

/** A backup lane serving a different model (Large 3 → Medium on a 429) is handed the native
 *  prompt written for that model, so it does not introduce itself as the model it replaced. The
 *  scaffolded path builds the same pairs from its persona (index.ts, CUR-2460); failover.ts applies a (CUR-2697)
 *  lane's pairs only when the turn moves to that lane. */
export function nativeLaneRewrites(
	model: { id?: string; name: string; endpoints?: ReadonlyArray<object> },
	system: string,
	promptFor: (modelId: string) => string
): Record<string, Array<[string, string]>> {
	const primaryId = model.id ?? model.name;
	const rewrites: Record<string, Array<[string, string]>> = {};
	// Keyed the way failover looks them up: `servedAs` before the wire `modelId` (CUR-3777).
	for (const laneId of laneModelIds(primaryId, model.endpoints ?? [])) {
		if (!laneId || laneId === primaryId || rewrites[laneId]) continue;
		const laneSystem = promptFor(laneId);
		if (laneSystem !== system) rewrites[laneId] = [[system, laneSystem]];
	}
	return rewrites;
}

/**
 * The prompt and tools of a turn whose plan says `retrieval: "tools"`. The model gets a short
 * system prompt, the injection fence around the person's latest message and its tools; it decides what
 * to search and when to calculate. The turn itself is textGenerationWithoutTitle (index.ts), the same one
 * every plan runs, so this builds the request and runs nothing.
 *
 * @param unhardenedUserText the person's latest message after preprocessing, before the fence. (CUR-2697)
 */
export async function toolTurnPrompt(
	ctx: TextGenerationContext,
	unhardenedUserText: string | undefined,
	turnPrefs: TurnPreferences,
	/** A message in the conversation carries an attached document (CUR-4102). */
	documentAttached = false
): Promise<{
	preprompt: string;
	fence: string;
	laneRewrites: Record<string, Array<[string, string]>>;
	kit: NativeToolKit;
	grounding: () => NativeGrounding;
}> {
	const web = (ctx.webSearchMode ?? "off") !== "off";
	// The link the person pasted, read through read_page (nativeTools.ts) as the pipeline turn
	// reads it (CUR-1897), and named when search is off so the answer says why (CUR-2032). (CUR-2734)
	const pastedUrl = extractLinkedUrl(unhardenedUserText ?? "");
	// A photo this model reads came with the message, so search waits for what the photo can't show. (CUR-3192)
	const photoAttached =
		modelTakesImagesNow(ctx.model) &&
		(ctx.messages.findLast((m) => m.from === "user")?.files ?? []).some((f) => f.mime?.startsWith("image/"));
	const fence = `Q_${randomUUID().slice(0, 8)}`;
	// The person's own numbered sources keep [1]..[k]; ours are numbered after them. The route
	// counted them from the typed text; unhardenedUserText also carries attached documents. (CUR-3844)
	const visitorSourceCount = ctx.visitorSourceCount ?? 0;

	// The same per-turn provenance facts the pipeline turn carries, built per model so a backup
	// lane's rewritten prompt names the model that lane serves. (CUR-2135)
	await ensureFlagsPolled();
	const factsOn = provenanceFactsEnabled();
	// The person's own earlier chats, searchable this turn only with an account, their switch on
	// and the flag on. (CUR-4576)
	const pastChatsOwner =
		pastChatSearchOn(ctx.locals, turnPrefs.searchPastChats) && ctx.locals?.user?._id
			? { userId: ctx.locals.user._id.toString(), currentConversationId: ctx.conv._id.toString() }
			: undefined;
	const previous = previousServedRecord(ctx.messages);
	const { models: listedModels } = await import("$lib/chat/server/models");
	const features = resolveFeatureFacts(ctx.model, {
		webSearchMode: ctx.webSearchMode,
		speakMode: resolveSpeakMode(ctx.speakMode, ctx.speakAll),
		listed: listedModels,
		catalogTool: true,
		account: { loginOffered: loginEnabled(), signedIn: !!ctx.locals?.user },
	});
	// The pipeline turn's serving facts, from the same authority the provenance badge reads.
	const serving = factsOn
		? undefined
		: servingClause(
				servingFor(ctx.model, ctx.model.id ?? ctx.model.name)
			);
	const promptFor = (modelId: string) =>
		nativeSystemPrompt({
			provenanceFacts: factsOn ? buildProvenanceFacts({ modelId, previous }) : undefined,
			serving,
			modelId,
			fence,
			today: todayLine(ctx.locals?.timezone),
			web,
			linkOffBySearch: !!pastedUrl && !web,
			unservableLive: ctx.unservableLive,
			account: {
				loginOffered: loginEnabled(),
				signedIn: !!ctx.locals?.user,
				dataExport: dataExportEnabled(),
				pastChats: !!pastChatsOwner,
			},
			// A backup lane's prompt says it is that lane's model, so its list of models does too. (CUR-3895)
			features: modelId === (ctx.model.id ?? ctx.model.name) ? features : laneFeatureFacts(features, modelId, listedModels),
			screeningFacts: ctx.screeningFacts,
			visitorSourceCount,
			photoAttached,
			documentAttached,
			// The person's answer preferences, in the system role since the native turn's user
			// message carries the fence alone (index.ts). (CUR-3929)
			answer: turnPrefs.answer,
		});
	const system = promptFor(ctx.model.id ?? ctx.model.name);
	const laneRewrites = nativeLaneRewrites(ctx.model, system, promptFor);
	// Personalization is read for this turn, the same way the pipeline turn reads it. (CUR-1443)
	const extra = effectivePreprompt(ctx.conv.preprompt, turnPrefs);
	// The configured MCP servers' tools join this turn's own, when the flag is on. (CUR-3026)
	// With the conversation's sandbox too, when `one-chat-sandbox` is on. (CUR-4232)
	const mcpKit = await mcpServersKitForTurn(ctx, undefined, undefined, { withSandbox: true });
	const withExtra = extra?.trim() ? `${system}\n\n${extra}` : system;
	const preprompt = mcpKit ? `${withExtra}\n\n${mcpToolsClause(mcpKit)}` : withExtra;
	const forceWeb = forcesWebSearch({
		mode: ctx.webSearchMode,
		photoAttached,
		pastedUrl: !!pastedUrl,
		gateSaysSearch: !!(await ctx.nativeSearchGate),
	});
	// The typed message, not unhardenedUserText, which also carries attached documents. (CUR-4376)
	const typed = ctx.messages.findLast((m) => m.from === "user")?.content?.trim();
	const askedLanguage =
		web && typed && flagEnabledOr(SEARCH_QUERY_LANGUAGE_FLAG, () => false)
			? await readMessageLanguage(typed)
			: undefined;
	const baseKit = nativeToolKit({
		locals: ctx.locals,
		web,
		forceWeb,
		liveUnservable: ctx.unservableLive,
		linkedUrl: pastedUrl,
		visitorSourceCount,
		latest: asksForTheLatest(unhardenedUserText ?? ""),
		calculateCounts: asksCalculateCounts(ctx.model.id ?? ctx.model.name),
		readPage: (url) => fetchLinkedPage(url, { skipFirecrawl: ctx.faultInjection === "linked_page_firecrawl_down" }),
		hangWeb: ctx.faultInjection === "web_search_hangs",
		askedLanguage,
		pastChats: pastChatsOwner,
	});
	return {
		preprompt,
		fence,
		laneRewrites,
		kit: mcpKit ? composeKits(baseKit, mcpKit) : baseKit,
		grounding: () => baseKit.grounding(),
	};
}
