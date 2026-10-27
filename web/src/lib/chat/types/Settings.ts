import { defaultModel } from "$lib/chat/server/models";
import type { AnswerLanguage, Emojis, Format, Length, Tone } from "$lib/chat/answerPreferences";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";
import type { McpToolPolicy } from "$lib/chat/mcpToolPolicy";

export type StreamingMode = "raw" | "smooth";
export type ReasoningEffort = "low" | "medium" | "high";

export interface Settings extends Timestamps {
	userId?: User["_id"];
	sessionId?: string;

	/** One-time welcome modal acknowledgement */
	welcomeModalSeenAt?: Date | null;
	activeModel: string;

	// model name and system prompts
	customPrompts?: Record<string, string>;

	/**
	 * Per-model toggle to enable/disable the custom system prompt
	 * without deleting its contents. Defaults to `true` (enabled).
	 */
	customPromptsEnabled?: Record<string, boolean>;

	/**
	 * Per‑model overrides to enable multimodal (image) support
	 * even when not advertised by the provider/model list.
	 * Only the `true` value is meaningful (enables images).
	 */
	multimodalOverrides?: Record<string, boolean>;

	/**
	 * Per-model artifacts toggle. Overrides the model's `supportsArtifacts`
	 * config flag in both directions: `true` enables artifacts on an unflagged
	 * model, `false` disables them on a flagged one.
	 */
	artifactsOverrides?: Record<string, boolean>;

	/**
	 * Per-model toggle to hide Omni prompt suggestions shown near the composer.
	 * When set to `true`, prompt examples for that model are suppressed.
	 */
	hidePromptExamples?: Record<string, boolean>;

	/**
	 * Per-model thinking effort. Sent as `reasoning_effort` to the OpenAI-compatible
	 * endpoint when set; omitted (provider default) when missing.
	 */
	reasoningEffortOverrides?: Record<string, ReasoningEffort>;

	/**
	 * Per-model override for whether the Reasoning-effort UI should appear and
	 * `reasoning_effort` should be forwarded. Falls back to `model.supportsReasoning`.
	 */
	reasoningOverrides?: Record<string, boolean>;

	/**
	 * Preferred assistant output behavior in the chat UI.
	 * - "raw": show provider-native stream chunks
	 * - "smooth": show smoothed stream chunks
	 */
	streamingMode: StreamingMode;
	directPaste: boolean;

	/**
	 * Whether haptic feedback is enabled on supported touch devices.
	 * Uses the ios-haptics library for cross-platform vibration.
	 */
	hapticsEnabled: boolean;

	/**
	 * Organization to bill inference requests to (HuggingChat only).
	 * Stores the org's preferred_username. If empty/undefined, bills to personal account.
	 */
	billingOrganization?: string;

	/**
	 * per-account override of the CUR-1430 reply-language rule (write the whole reply in
	 * the asker's language, never opening in English because the instructions were). `undefined`
	 * means no preference set — the turn path falls back to the global rollout flag
	 * (`replyLanguageRuleEnabled()`); an explicit `true`/`false` here always wins over that flag,
	 * since a person's own choice outranks a rollout percentage. (CUR-1443)
	 */
	replyInUserLanguage?: boolean;

	/**
	 * per-account override of whether Alpha refers to itself as a machine ("I'm a
	 * machine — {model}. I have no feelings...") or is allowed a person-style first-person register
	 * (CUR-3930). `undefined`/`false` keeps today's fixed machine framing — there is no rollout flag
	 * for this one, only the account setting. One of answerPreferences.ts's fields: a reset is sent as
	 * `null` and stored as unset. (CUR-1443)
	 */
	selfReferenceAsPerson?: boolean;

	/**
	 * How Alpha writes to this person (answerPreferences.ts). Each is optional and unset by
	 * default; `undefined` means Alpha's default, and no entry in `DEFAULT_SETTINGS` fills one in, so
	 * the row says only what the person chose. A reset is sent as `null` and stored as unset. (CUR-3929)
	 */
	tone?: Tone;
	answerLength?: Length;
	/** Whether an answer may add next steps, offers and questions back. */
	suggestions?: boolean;
	/** `auto` is the question's language; a fixed code wins on every prompt path. */
	answerLanguage?: AnswerLanguage;
	/** Short sentences, everyday words, no jargon. */
	plainLanguage?: boolean;
	/** prose, bullets, or whatever fits. (CUR-549) */
	answerFormat?: Format;
	/** Never an emoji, or one where it helps. (CUR-549) */
	emojis?: Emojis;
	/** Show the model and host under each answer and in X-ray. UI only. (CUR-549) */
	showServing?: boolean;
	/**
	 * Settings → Connectors. The person's choice per connected MCP tool, keyed by its
	 * `server__tool` name: allow (no confirmation card), ask (the default) or block (never runs). (CUR-3984)
	 */
	mcpToolPolicies?: Record<string, McpToolPolicy>;
	/**
	 * Settings → Personalization, "Search my past chats". When true and the
	 * `past-chat-search` flag is on, a signed-in person's turns may search their own earlier chats.
	 * `undefined` is off. (CUR-4576)
	 */
	searchPastChats?: boolean;
	/**
	 * Settings → Personalization, "Ask before every step". Agent mode runs in auto mode by default:
	 * agent-service runs what its reviewer clears and asks only before a delete. True opens an approval
	 * card for every edit and shell or code call instead. `undefined` is off.
	 */
	agentAskEveryStep?: boolean;
}

export type SettingsEditable = Omit<Settings, "welcomeModalSeenAt" | "createdAt" | "updatedAt">;
export const DEFAULT_SETTINGS = {
	// defaultModel is unset during `vite build` (models aren't fetched at build time) and, with the
	// retrying registry init, possibly until the first successful catalog fetch — a getter reads the
	// live binding at spread/use time instead of freezing "" in for the life of the process.
	get activeModel() {
		return defaultModel?.id ?? "";
	},
	customPrompts: {},
	customPromptsEnabled: {},
	multimodalOverrides: {},
	artifactsOverrides: {},
	hidePromptExamples: {},
	reasoningEffortOverrides: {},
	reasoningOverrides: {},
	streamingMode: "smooth",
	directPaste: false,
	hapticsEnabled: true,
} satisfies SettingsEditable;
