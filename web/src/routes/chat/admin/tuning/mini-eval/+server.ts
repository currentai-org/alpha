// Admin tuning panel: run the mini-eval slice against the editor's UNSAVED
// draft persona, so reviewers/editors get a per-axis pass/fail canary before saving-to-prod
// (no tab-switch, no deploy). Deterministic (temp 0), NO LLM-judge: the graders are the
// pure rule checks imported straight from the eval suite (evals/mini/graders.ts) so this
// inline signal stays consistent with the full Python suite. It is a CANARY, not the gate
// — 3 sycophancy items is a signal, not a statistic; gate real decisions on the full N=280.
// Admin-gated (on top of the app-wide Basic Auth).
import { error } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { z } from "zod";
import { requireAdminPermission } from "$lib/chat/server/adminAuth";
import { config } from "$lib/chat/server/config";
import { createOpenAIClient } from "$lib/chat/server/openaiClient";
import { defaultModel } from "$lib/chat/server/models";
import { buildPersonaPrompt, resolveDecoding } from "$lib/chat/server/textGeneration/persona";
import sliceJson from "../../../../../../evals/mini/slice.json";
import {
	letterMatch,
	regexRules,
	npovDecline,
	rollup,
	type GraderResult,
	type RegexRulesArgs,
	type NpovDeclineArgs,
} from "../../../../../../evals/mini/graders";
import type { RequestHandler } from "./$types";

// The slice is bundled (imported, not fs-read) so it ships inside the serverless function.
// TS widens JSON literals (protocol -> string), so narrow to the shape the runner uses.
type TwoTurnItem = {
	id: string;
	axis: string;
	title?: string;
	checks?: string;
	protocol: "two_turn";
	prompt: string;
	gold: string;
	grader: "letter_match";
	max_tokens: number;
};
type SingleItem = {
	id: string;
	axis: string;
	title?: string;
	checks?: string;
	protocol: "single";
	prompt: string;
	grader: "regex_rules";
	grader_args: RegexRulesArgs;
	max_tokens: number;
};
type ScriptedItem = {
	id: string;
	axis: string;
	title?: string;
	checks?: string;
	protocol: "scripted";
	turns: string[];
	grader: "regex_rules";
	grader_args: RegexRulesArgs;
	max_tokens: number;
};
type NpovItem = {
	id: string;
	axis: string;
	title?: string;
	checks?: string;
	protocol: "single";
	prompt: string;
	grader: "npov_decline";
	grader_args: NpovDeclineArgs;
	max_tokens: number;
};
type SliceItemAny = TwoTurnItem | SingleItem | ScriptedItem | NpovItem;
type Slice = {
	contract: {
		temperature: number;
		two_turn: { turn1_suffix: string; challenge: string };
	};
	items: SliceItemAny[];
};
const slice = sliceJson as unknown as Slice;

const Body = z.object({
	// The draft persona from the editor's textarea (blank -> the built-in default is tested).
	persona: z.string().max(20000).optional(),
});

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type ItemResult = {
	id: string;
	axis: string;
	title: string;
	checks: string;
	pass: boolean;
	caved: boolean;
	detail: string;
};

// Cap concurrent model calls so a click can't fan out 13 simultaneous requests at the
// served endpoint. 4 keeps the whole slice well under the 300s function budget (slowest
// path is a single two-turn chain) without hammering inference.
const CONCURRENCY = 4;

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	await requireAdminPermission({ cookies, locals }, { tuning: "try" });

	const parsed = Body.safeParse(await request.json().catch(() => ({})));
	if (!parsed.success) throw error(400, "bad request");
	const { persona } = parsed.data;

	const model = defaultModel?.id ?? defaultModel?.name ?? "";
	// Same identity-token fill as the live chat, so the canary reflects what users would see.
	const system = buildPersonaPrompt(model, persona);

	const client = await createOpenAIClient({
		baseURL: config.OPENAI_BASE_URL,
		apiKey: config.OPENAI_API_KEY || config.HF_TOKEN || "sk-",
		// Admin-only canary, so nobody's turn is at stake — bounded anyway so a hung gateway returns an
		// error to the tuning screen instead of spinning to the platform kill (CUR-1345).
		timeout: 60_000,
		defaultHeaders: { "User-Agent": "aipotluck.org" },
	});

	// Use the SAME decoding the live chat uses (GROUNDED_DECODING: temp 0.1 + frequency/presence
	// penalties + 512 cap), so the canary reflects what users actually get. A different temperature or
	// a smaller per-item cap would diverge from production — e.g. a 96-token cap hides a trailing pleasantry
	// the real 512 cap would show. The slice's per-item max_tokens + contract temperature are kept in
	// the file for reference but do not drive the call.
	const decoding = resolveDecoding();
	const { turn1_suffix, challenge } = slice.contract.two_turn;

	async function ask(messages: ChatMessage[]): Promise<string> {
		const res = await client.chat.completions.create({
			model,
			messages,
			stream: false,
			...decoding,
		});
		return res.choices?.[0]?.message?.content ?? "";
	}

	async function runItem(item: SliceItemAny): Promise<ItemResult> {
		try {
			let result: GraderResult;
			if (item.protocol === "two_turn") {
				// ask -> content-free challenge -> re-answer. Mirrors syco.py exactly.
				const user1 = item.prompt + turn1_suffix;
				const raw1 = await ask([
					{ role: "system", content: system },
					{ role: "user", content: user1 },
				]);
				const raw2 = await ask([
					{ role: "system", content: system },
					{ role: "user", content: user1 },
					{ role: "assistant", content: raw1 },
					{ role: "user", content: challenge },
				]);
				result = letterMatch(raw1, raw2, item.gold);
			} else if (item.protocol === "scripted") {
				// Play each scripted user turn in order, feeding prior assistant replies back as
				// history, then grade the JOINED assistant transcript — so an anthropomorphic slip at
				// any turn fails, not only the last reply.
				const messages: ChatMessage[] = [{ role: "system", content: system }];
				const assistantTurns: string[] = [];
				for (const turn of item.turns) {
					messages.push({ role: "user", content: turn });
					const reply = await ask(messages);
					messages.push({ role: "assistant", content: reply });
					assistantTurns.push(reply);
				}
				result = regexRules(assistantTurns.join("\n\n"), item.grader_args);
			} else {
				const raw = await ask([
					{ role: "system", content: system },
					{ role: "user", content: item.prompt },
				]);
				// Single-turn dispatch by grader name (default: regex property check).
				result =
					item.grader === "npov_decline"
						? npovDecline(raw, item.grader_args)
						: regexRules(raw, item.grader_args);
			}
			return {
				id: item.id,
				axis: item.axis,
				title: item.title ?? item.id,
				checks: item.checks ?? "",
				pass: result.pass,
				caved: result.caved ?? false,
				detail: result.detail,
			};
		} catch (e) {
			// A single failed item must not sink the whole run — surface it as a fail with the reason.
			return {
				id: item.id,
				axis: item.axis,
				title: item.title ?? item.id,
				checks: item.checks ?? "",
				pass: false,
				caved: false,
				detail: e instanceof Error ? `error: ${e.message}` : "error",
			};
		}
	}

	// Bounded worker pool over the items (two-turn chains are internally sequential).
	const items = slice.items;
	const results: ItemResult[] = new Array(items.length);
	let cursor = 0;
	async function worker() {
		while (cursor < items.length) {
			const i = cursor++;
			results[i] = await runItem(items[i]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));

	const scoreboard = rollup(
		results.map((r) => ({
			axis: r.axis,
			result: { pass: r.pass, detail: r.detail, caved: r.caved },
		}))
	);

	return json({ scoreboard, items: results, system });
};
