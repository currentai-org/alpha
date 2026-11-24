// Every PostHog flag key the server reads, declared once.
//
// ── Why a registry at all ────────────────────────────────────────────────────────────────────────
// `flagEnabledOr` answers an unknown key by calling the caller's fallback, and that is the right
// RUNTIME behaviour — a flag nobody has created yet must not silently turn a feature off (flags.ts).
// But every gate we ship passes `() => false`, so three very different states collapse into one
// observable: the flag exists and is off, nobody ever created the flag, and the key in code is a typo
// all behave identically and emit nothing. A gate whose flag was never created is dark on every
// deployment, with no lever to turn it on and no line anywhere saying so.
//
// The env plane has this check in six forms (env-audit, env-drift, check-prod-env,
// verify-prod-config, gen-env-ci, config-diff). This is the flag plane's version, kept to the smallest
// shape that can actually go red: a list, compared against what PostHog returned.
//
// ── What this catches, and what it does not ──────────────────────────────────────────────────────
// `refreshFlags` warns for a registered key PostHog did not return — deleted, renamed, archived, or
// never created. `flagKeys.spec.ts` pins this list against the constants the gate modules export, so a
// key edited in one place and not the other goes red in CI.
//
// NEITHER catches a brand-new `flagEnabledOr("something-new", …)` whose author never added it here.
// That would need a source scan, and an audit regex that silently under-counts is worse than no audit
// (the tool that reports the number needs verifying too). The spec below enforces agreement for the keys
// we know about; it is not a guarantee about keys we don't. Adding a gate means adding its key here.
//
// ── Why existence is not the whole question ──────────────────────────────────────────────────────
// Both checks above ask whether a flag EXISTS. Neither reads its release conditions, and neither knows
// what the flag is FOR, so both stay green while a fix flag sits at `env exact preview`, 100%, no
// production group, with the defect it fixes shipping to every production user. Its PostHog
// description ("off by default; flip after live-verify against a preview build") reads the same as
// the descriptions on flags for surfaces nobody has ever seen.
//
// `class`, `codeDefault` and `verified` below are those three unstated facts written down: what the
// flag is for, which way the code falls without it, and whether anyone has actually watched it work.
// `flag-class-audit.mjs` reads all three against live PostHog and reports the one combination that is
// a finding rather than a status — a verified fix, whose code defaults off, with no production
// release condition. It decides nothing and flips nothing; it makes the outstanding decisions visible
// instead of remembered. Who decides each one splits on exactly the axis `class` records — a broad
// production rollout is one call, and a fix behind a kill switch is another.

/**
 * What a flag is FOR, which is what decides where it should end up and whether "preview-only, nine
 * days later" is the plan or a finding.
 *
 * WHY THIS IS A FIELD AND NOT PROSE. Every entry below already describes itself in `gates` and
 * `whenAbsent`, and the descriptions in PostHog say the same things — but they say them in the same
 * WORDS regardless of class. The sentence "off by default; flip after live-verify against a preview
 * build" appears verbatim on `arithmetic-guard`, which repairs a defect production has right now, and
 * on flags for surfaces nobody has ever seen. Read as prose those are indistinguishable, so nothing
 * could tell you that one of them was overdue, so a reproducible defect could ship in production
 * while its verified fix sat preview-only. A field can be checked; a sentence
 * that reads the same either way cannot.
 *
 * This is deliberately NOT the same axis as `whenAbsent`. That records which way the code defaults
 * when PostHog is silent (a rollout gate defaults off; a kill switch like `crisis-referral-order`
 * defaults on). A fix can legitimately be either — starting a new guard dark is often right, and
 * a filler-opener guard is the argument for it: it
 * never fired and would have deleted a one-word answer. What `class` adds is the END STATE, which `whenAbsent` says nothing
 * about.
 */
type FlagClass =
	/**
	 * Repairs a defect that is live in production. Its end state is on in production; until then the
	 * bug is live. Shipping one dark is fine — leaving it dark after it verifies is the thing this
	 * class exists to make visible (flag-class-audit.mjs).
	 */
	| "fix"
	/**
	 * Adds a surface that did not exist. Dark is the correct resting state for as long as anyone
	 * wants, and nothing about it being dark is a finding.
	 */
	| "feature"
	/**
	 * Chooses between two implementations of the same job. Temporary by construction: the end state
	 * is deleting the losing path AND this key together, not a permanently-100% flag (flags.ts).
	 */
	| "migration"
	/**
	 * Measure-only. Changes nothing a user sees either way, so neither "should reach production" nor
	 * "should stay dark" applies — it runs where the measurement is wanted.
	 */
	| "probe";

/**
 * Which way the CODE falls when PostHog says nothing — the machine-readable half of `whenAbsent`,
 * which says the same thing in prose that nothing can check.
 *
 * It exists because the audit needs it and cannot derive it. "A fix with no production release
 * condition" is a finding only for a flag whose code defaults OFF; for `crisis-referral-order` and
 * `entity-name-correction`, whose code defaults ON, no production condition means the fix is ALREADY
 * running everywhere and a warning would be exactly backwards. Reading the fallback out of the source
 * would need a regex over `flagEnabledOr(KEY, () => …)`, and an audit regex that silently under-counts
 * is worse than no audit.
 *
 * Every value below was read off the actual `flagEnabledOr` call site, not inferred from `whenAbsent`.
 */
type FlagCodeDefault =
	/** `() => true`. The flag's presence at 0% is what turns the feature OFF — a kill switch. */
	| "on"
	/** `() => false`. The flag is what turns the feature ON — a rollout gate. */
	| "off"
	/** An env var, const, or `deployEnv()` decides, so neither plain answer is true. */
	| "env";

/**
 * Whose answer a signed-in request reads. flags.ts evaluates every flag once per signed-in
 * account, with the account id as distinct id and `env`, `account_id` and `email` as person properties, so a
 * production release condition can say "team accounts only" and mean it.
 *
 * A flag whose value builds something every visitor shares cannot take a per-account answer: the model
 * registry, a cache, sign-in being offered at all, a route no visitor calls. If the registry were built
 * during a team member's request it would carry their answer to everyone after them. Those are marked
 * `deployment`, and `flagEnabledOr` reads the deployment snapshot for them whoever is asking.
 */
type FlagScope =
	/** Signed in: this account's answer. Signed out: the deployment snapshot. */
	| "account"
	/** Always the deployment snapshot. */
	| "deployment";

/**
 * Evidence that a live probe actually exercised this flag ON, against a real deployment — a
 * green unit suite is never, by itself, evidence a fix is done, so the probe is recorded here.
 *
 * `servedBy` is not decoration. The gateway's fallback ladder scatters across model families, so a
 * probe result is only valid for the lane that answered it: a preview pass is a pass FOR one
 * model. Recording it makes "verified" a claim with a
 * scope instead of a mood.
 */
type FlagVerification = {
	/** ISO date (YYYY-MM-DD) the probe ran. */
	on: string;
	/** The probe and its result, specific enough to re-run — not "looked fine". */
	evidence: string;
	/**
	 * The model that actually served during the probe, from `routerMetadata.model` — never
	 * the badge, which names one model no matter which lane answered.
	 */
	servedBy: string;
};

/**
 * The conditions that can stand in for an env var in `onWhenEnv`, each with how selfhost/README.md's
 * flag table states it (scripts/selfhost-flag-table.mjs) for the env names it stands in for. flags.ts's
 * `satisfiedInstead` evaluates each one.
 */
export const SELF_HOST_CONDITIONS = {
	/** ALPHA_EDITION=selfhost with the variable itself unset, so an explicit "false" still reads off (edition.ts). */
	"self-host-edition-unless-set": (names: string) =>
		`\`ALPHA_EDITION=selfhost\` stands in for ${names} when it is unset`,
	/** CSAM_SCAN=off on a set, non-hosted edition (csamScan.ts, csamScanOptedOut). */
	"csam-scan-opted-out": (names: string) =>
		`\`CSAM_SCAN=off\` (with \`ALPHA_EDITION\` set to something other than \`hosted\`) stands in for ${names}`,
} as const;

export type FlagSelfHostCondition = keyof typeof SELF_HOST_CONDITIONS;

/**
 * What a flag reads as on a self-hosted deployment, meaning one with no PUBLIC_POSTHOG_KEY. It is the
 * only answer used there; a deployment with PostHog configured never reads it. `ALPHA_FLAGS="+key,-key"`
 * overrides it per key (flags.ts, selfHostFlagValue).
 */
export type FlagSelfHost =
	/** On. */
	| "on"
	/** Off. Also the value for a flag whose self-host default is a pending product decision. */
	| "off"
	/** The call site's own fallback, unchanged: there is no better self-host answer than what the code does without PostHog. */
	| "code"
	/** On exactly when every named env var is set (non-empty, and not false/0/no/off); otherwise off. */
	| {
			onWhenEnv: string[];
			/** Env names in `onWhenEnv` that count as set when the named condition holds instead. */
			satisfiedBy?: Record<string, FlagSelfHostCondition>;
	  };

export type FlagKeySpec = {
	/** The key as PostHog stores it. No dots — PostHog rejects them in flag keys. */
	key: string;
	/** What this flag is for, and so where it is supposed to end up. See FlagClass. */
	class: FlagClass;
	/** Which way the code falls with PostHog silent, read off the call site. See FlagCodeDefault. */
	codeDefault: FlagCodeDefault;
	/** What the flag reads as with PostHog not configured. Required, so a new key states it. See FlagSelfHost. */
	selfHost: FlagSelfHost;
	/** Whose answer `flagEnabledOr` reads for a signed-in visitor. See FlagScope. */
	scope: FlagScope;
	/** Who decides this flag's release conditions and when it gets removed. */
	owner: string;
	/**
	 * ISO date (YYYY-MM-DD) by which `owner` removes this flag or sets a later date on purpose.
	 * Required for `fix`, `migration` and `probe`, which are temporary by their own class docs above;
	 * optional for `feature`, whose resting state can be dark for as long as anyone wants.
	 *
	 * A date in the past is reported by `flag-class-audit.mjs` (daily, to the alerts channel), never by a
	 * PR-blocking test: a check that turns red on a calendar date blocks whoever happens to push that
	 * day, for a flag they never touched. What does block a PR is a required class with no valid date,
	 * which can only fire on the PR that adds or edits the entry.
	 */
	expires?: string;
	/** What turns on when it is on. */
	gates: string;
	/** What the code actually does when PostHog does not define this key, in prose. Most entries fall
	 *  back to OFF, which is why the absence is invisible without the warning in refreshFlags; the
	 *  exceptions are named by `codeDefault` above, which is this same fact in a checkable form. */
	whenAbsent: string;
	/**
	 * The `linear:cur-NNN` tag this flag carries (or should carry) in PostHog, the link between a Linear
	 * ticket and the PostHog flag that gates it; `trig link`/`trig status` read and write this tag.
	 * Filled in by whoever adds the entry, same moment as `owner`/`gates`, not a separate step to
	 * remember.
	 *
	 * Not always "the ticket that shipped this feature": where the two diverge, a comment on the entry
	 * says so. This field always matches PostHog's actual tag (or the intended one, for a flag not yet
	 * created).
	 */
	ticket: string;
	/**
	 * Other registered keys this flag's own release conditions must stay a subset of — a declared
	 * relationship, not one only implied by a `gates` comment cross-referencing another entry. A gate
	 * composed in prose only can drift: a parent flag can get a production release group its child lacks,
	 * and production silently loses the child's surface with nothing to catch it.
	 *
	 * Exported by `flags-export.mjs` for `trig reconcile` to read; `trig` itself does not yet assert
	 * anything about it. The relationship is real and worth stating regardless of when the
	 * checker catches up to it.
	 */
	requires?: string[];
	/**
	 * Present once a live probe has exercised this flag ON. Absent means not yet — which is a normal
	 * state, not a defect, and carries no warning of its own.
	 *
	 * Only meaningful in combination with `class`: a `fix` that is verified and still has no
	 * production release condition is the case `flag-class-audit.mjs` reports, because the defect it
	 * repairs is live and the repair is known to work. Nothing checks this for the other classes.
	 */
	verified?: FlagVerification;
	/**
	 * The scenario specs (file names under `web/e2e/scenarios/`) that force this flag on and off
	 * through `setFlagOverrides`, so each state of the gated code runs somewhere. A flag
	 * tested in one state only ships its other state unrun, and flipping it later is the first time
	 * anyone sees that code. `flagKeys.spec.ts` checks each named file really forces that state, and
	 * holds the list of non-probe flags still missing one, which may only shrink.
	 */
	specs?: { on?: string; off?: string };
	/**
	 * Set on a flag that gates a safety or moderation behaviour: a screen, a judge, a crisis or
	 * violence path. `verify-flags.mjs` reads it to decide how loud an unconfirmed intent is: an
	 * unconfirmed safety flag fails the run, any other unconfirmed flag only warns, because a safety
	 * flag sitting off in production with nobody having said so is the state worth a red.
	 */
	safety?: true;
};

/**
 * Identity at runtime. It exists so the compiler infers each entry's `key` as its literal, which is
 * what `FlagKey` below is derived from; an annotation of `FlagKeySpec[]` would widen every key to
 * `string` and leave nothing to derive.
 */
function defineFlagKeys<K extends string>(specs: Array<FlagKeySpec & { key: K }>): Array<FlagKeySpec & { key: K }> {
	return specs;
}

/**
 * The keys the server reads. Order is the order they appear in the warning, so keep it stable.
 *
 * A flag nobody removes is worse than no flag (flags.ts) — each entry carries an owner so there is
 * someone to ask when it has outlived its rollout.
 */
export const FLAG_KEYS = defineFlagKeys([
	{
		key: "local-inference",
		scope: "account",
		codeDefault: "env",
		selfHost: "on",
		class: "feature",
		owner: "chat",
		gates:
			"the per-user local (LAN/self-hosted) inference endpoint feature as a whole — the settings " +
			"surface, its CRUD routes, and whether a user's own endpoints are resolved into the model " +
			"registry at all (localEndpointsGate.ts; localModels.ts short-circuits on it, so a model " +
			"that is off here is never served, not merely hidden)",
		whenAbsent:
			"on in local development only, off everywhere else — the deployEnv() fallback in " +
			"localEndpointsGate.ts, so a laptop with no PostHog can still exercise the feature while " +
			"a real deployment stays dark until the flag says otherwise",
		ticket: "CUR-3175",
	},
	{
		key: "local-inference-managed",
		scope: "account",
		codeDefault: "env",
		selfHost: { onWhenEnv: ["PANGOLIN_API_URL", "PANGOLIN_INTEGRATION_TOKEN", "PANGOLIN_ORG_ID", "PANGOLIN_DOMAIN_ID", "PANGOLIN_TUNNEL_ENDPOINT"] },
		class: "feature",
		owner: "chat",
		// Separate from `local-inference` rather than derived from it, for the reason
		// managedInferenceGate.ts's own header gives: managed endpoints need a whole second piece of
		// infrastructure (Pangolin), so turning one off without the other has to stay a one-line
		// change. `requires` states the subset relationship the prose used to only imply.
		requires: ["local-inference"],
		gates:
			"the managed (tunnel-provisioned) half of local inference — the \"Add a managed server\" " +
			"block and its provisioning route (managedInferenceGate.ts). Not whether Pangolin is " +
			"reachable right now, which is a live probe the UI answers by disabling the Pair control",
		whenAbsent:
			"on in local development only, off everywhere else — same deployEnv() fallback as " +
			"local-inference",
		ticket: "CUR-3175",
	},
	{
		key: "agent-mode",
		scope: "deployment",
		specs: { on: "everyday-jobs.spec.ts", off: "data-portability.spec.ts" },
		codeDefault: "env",
		selfHost: { onWhenEnv: ["AGENT_SERVICE_URL", "AGENT_SERVICE_TOKEN"] },
		class: "feature",
		owner: "chat",
		gates:
			// Both agentModeEnabled() and agentModeEnabledForUser() (agentMode.ts) check deployEnv() first,
			// then poll AGENT_MODE_FLAG, and this description has to match that call site.
			"registration of the Apertus-Agent model and per-user access to it (both agentMode.ts: deployEnv() === \"preview\" | \"production\" gates first, then AGENT_MODE_FLAG is polled from PostHog — CUR-770/CUR-771)",
		whenAbsent: "agent mode off everywhere — the model is never registered and never offered",
		// PostHog's actual tag, not the ticket that put agent-mode behind a flag: trig's
		// Linear↔PostHog link work used agent-mode as its pilot/reference flag.
		ticket: "CUR-515",
	},
	// There is deliberately no `apertus15` flag: a rollout ends by making the checkpoint the
	// configured default, not by leaving a permanently-100% flag behind. A flag nobody removes is worse
	// than no flag (flags.ts). Delete the definition in PostHog too: a key that
	// exists and is read by nothing is the same invisible state this registry was built to surface.
	{
		key: "multimodal",
		// Per account; on for everyone on preview. The model registry reads
		// `multimodalConfigured()`, and each request asks `modelTakesImagesNow`, so no shared build
		// carries one visitor's answer to the next.
		scope: "account",
		specs: { on: "guest-uploads.spec.ts", off: "bring-your-own-text.spec.ts" },
		codeDefault: "off",
		selfHost: {
			onWhenEnv: ["MULTIMODAL_ENABLED", "CSAM_SCAN_BASE_URL", "CSAM_SCAN_TOKEN"],
			// CSAM_SCAN=off on a self-host edition replaces the scanner pair (csamScan.ts, csamScanOptedOut).
			// ALPHA_EDITION=selfhost stands in for MULTIMODAL_ENABLED unless it is set (multimodalConfigured,
			//), so a self-host's uploads wait only on the operator's scan decision.
			satisfiedBy: {
				MULTIMODAL_ENABLED: "self-host-edition-unless-set",
				CSAM_SCAN_BASE_URL: "csam-scan-opted-out",
				CSAM_SCAN_TOKEN: "csam-scan-opted-out",
			},
		},
		class: "feature",
		owner: "trust-and-safety",
		gates:
			"image and audio input, file download and export attachments (multimodalMode.ts, re-exported as textOnly.ts)",
		whenAbsent:
			"multimodal shut on every deployment regardless of MULTIMODAL_ENABLED",
		ticket: "CUR-159",
	},
	{
		key: "dictation",
		scope: "account",
		codeDefault: "off",
		selfHost: { onWhenEnv: ["TRANSCRIPTION_MODEL"] },
		class: "feature",
		owner: "chat",
		gates:
			"the mic button in the composer and /chat/api/transcribe (dictationMode.ts, CUR-198) — independent of `multimodal`, since dictation only ever produces text and inherits the same moderation any typed message does",
		whenAbsent: "dictation shut on every deployment regardless of TRANSCRIPTION_MODEL",
		ticket: "CUR-198",
	},
	{
		key: "crisis-referral-order",
		safety: true,
		scope: "account",
		codeDefault: "on",
		selfHost: "code",
		class: "fix",
		owner: "chat",
		expires: "2026-12-31",
		gates:
			"inserting findahelpline.com and the person's local emergency services (no number, CUR-4141) ahead of a distress answer's first 988 line, and linking a findahelpline.com the model wrote as a bare domain (CUR-3909), and replacing any other phone number in a crisis answer with a findahelpline.com link (CUR-4061, helplineNumberGuard.ts) (crisisReferralOrder.ts, called from honestyStream.ts)",
		// A kill switch: the guard defaults ON and the flag only stops it.
		whenAbsent: "the guard keeps running — it defaults ON",
		ticket: "CUR-2136",
	},
	{
		key: "violence-recheck",
		safety: true,
		scope: "account",
		codeDefault: "off",
		selfHost: { onWhenEnv: ["GUARD_SHADOW_URL"] },
		class: "fix",
		owner: "chat",
		expires: "2026-12-31",
		gates:
			"a TASK_MODEL re-check of an input turn the violence rule alone blocked, releasing it only on an explicit literal_violence false (violenceRecheck.ts, called from inputGate.ts). Production waits on the privacy notice naming the side-call processor (CUR-2063)",
		whenAbsent: "OFF — a violence block stands as the screen scored it, idioms included",
		ticket: "CUR-1853",
	},
	{
		key: "support-signal-classifier",
		safety: true,
		specs: { on: "support-signal-multilingual.spec.ts", off: "self-harm-hedged.spec.ts" },
		scope: "account",
		codeDefault: "off",
		selfHost: { onWhenEnv: ["GUARD_SHADOW_URL"] },
		class: "fix",
		owner: "chat",
		expires: "2026-12-31",
		gates:
			"a TASK_MODEL forced tool call that reads the user's message in any language and stamps the Support resources card on distress, the writer's or a friend's (supportSignal.ts, called from the conversation endpoint). Production enable is its own ticket",
		whenAbsent: "OFF — only the guard's English distress rules stamp the card",
		ticket: "CUR-4093",
	},
	{
		key: "groundcheck",
		scope: "account",
		codeDefault: "off",
		selfHost: "off",
		class: "fix",
		owner: "chat",
		expires: "2026-12-31",
		gates:
			"deleting claims a grounded answer makes that its sources do not support: the groundcheck detector marks them, a TASK_MODEL call proposes deletions, and code keeps only pure word deletions (groundcheck.ts, called from honestyStream.ts). Production waits on CUR-2556",
		whenAbsent: "OFF — a grounded answer ships with whatever unsourced claims the model added",
		ticket: "CUR-2555",
	},
	{
		key: "conversation-titles",
		scope: "account",
		codeDefault: "off",
		selfHost: "on",
		class: "feature",
		owner: "chat",
		gates:
			"the model-generated conversation title, one extra call on the first clean turn (conversationTitles.ts, read from textGeneration/title.ts)",
		whenAbsent:
			"OFF, unconditionally (CUR-891) — the LLM_SUMMARIZATION mirror only ever mattered for the narrow cold-start window before a first successful PostHog poll, and failing closed there is the safer default",
		ticket: "CUR-258",
	},
	{
		key: "human-eval",
		scope: "account",
		specs: { on: "human-evaluation.spec.ts", off: "human-evaluation.spec.ts" },
		codeDefault: "off",
		selfHost: "on",
		class: "feature",
		owner: "chat",
		gates:
			"human evaluation of model answers per language (humanEval/gate.ts): the /chat/api/eval/* routes and the 'Help evaluate models in [language]' entry point on the models page (A2)",
		whenAbsent: "OFF, unconditionally",
		ticket: "CUR-1914",
	},
	{
		key: "read-aloud",
		scope: "account",
		codeDefault: "env",
		// On when READ_ALOUD_BASE_URL names a speech endpoint. HF_TOKEN is no switch, since boot copies
		// OPENAI_API_KEY into it, and the Hugging Face router would get the answer text; an operator
		// who wants that route sets ALPHA_FLAGS=+read-aloud.
		selfHost: { onWhenEnv: ["READ_ALOUD_BASE_URL"] },
		class: "feature",
		owner: "chat",
		gates:
			"read-aloud / TTS end to end (readAloudGate.ts): the server's effectiveSpeakMode in textGeneration/index.ts, the in-message audio player in ChatMessage.svelte, and the `hidden` class on the composer toggle in ChatInput.svelte. The last of those was an INDEPENDENT second off switch — flipping only the server one re-enables synthesis nobody can reach",
		whenAbsent:
			"the READ_ALOUD_ENABLED const decides, which is off — same as before the flag existed. " +
			"Kept deliberately (CUR-891, not converted like conversation-titles/data-export " +
			"above): $lib/chat/readAloud is imported by both the server generation path and two client " +
			"components, so it cannot import this server-only flags module — the const is the only " +
			"fallback the shared module can carry, not a leftover mirror",
		ticket: "CUR-225",
	},
	{
		key: "rag-entity-scope-guard",
		scope: "account",
		codeDefault: "off",
		selfHost: "on",
		class: "fix",
		owner: "chat",
		expires: "2026-12-31",
		gates:
			"the model check that a RAG hit surviving relevance is actually about the entity the query names, not just topically adjacent (rag/entityScopeGuard.ts, CUR-43)",
		whenAbsent:
			"off — a topically-relevant but wrong-entity chunk can still ground the answer, today's behavior",
		ticket: "CUR-43",
	},
	{
		key: "accounts",
		scope: "deployment",
		codeDefault: "env",
		// On: a self-host always has a working email sign-in, a code through its mailer or, with none,
		// email and password (mailer.ts), so the sign-in link shows without an OAuth client.
		selfHost: "on",
		class: "feature",
		owner: "chat",
		gates:
			"whether sign-in is offered at all (oidcConfig.ts's loginEnabled, read by handle.ts's two login gates and shipped to the client as page.data.loginEnabled)",
		whenAbsent:
			"loginEnabled falls back to !!OIDConfig.CLIENT_ID — today's env-presence behavior, unchanged from before this flag existed",
		ticket: "CUR-246",
	},
	{
		key: "agent-auto-mode",
		scope: "deployment",
		codeDefault: "on",
		selfHost: "on",
		class: "feature",
		owner: "chat",
		gates:
			"agent auto mode for everyone (agentConfirmUi.ts agentAutoApproveFor, CUR-3142): chat sends approval_mode=auto on /run unless the person turned on Settings → Personalization → Ask before every step. agent-service then runs what its reviewer clears and opens a card only before a delete. A kill switch: one deployment-wide answer, so setting it to 0% puts every agent turn back in ask mode with no deploy",
		whenAbsent: "auto mode, the default: only a person's own Ask before every step switch opens a card per step. Production enable: CUR-4487",
		ticket: "CUR-3142",
		specs: { on: "agent-auto-mode.spec.ts", off: "agent-auto-mode.spec.ts" },
		requires: ["agent-mode"],
	},
	{
		key: "agent-mode-access",
		scope: "account",
		codeDefault: "off",
		selfHost: "on",
		class: "feature",
		owner: "chat",
		gates:
			"WHICH ACCOUNTS see agent mode, where `agent-mode` decides whether it exists at all. Read per-person by agentModeEnabledForUser (agentMode.ts) with the account's real id as the distinct id and its email as a person property, so the selection of people lives in this flag's release conditions in PostHog and never as a roster in this repo. The user-visible surface is exactly this gate: the agent model registers `unlisted`, so the composer's AgentMode toggle (layoutData.ts `agentEnabled`) is the only path onto it",
		whenAbsent:
			"no account sees the toggle, even where agent-mode is on and the service URL is set — a per-person gate that cannot reach PostHog must not guess that the person is allowed",
		ticket: "CUR-1440",
		// A SECOND key rather than a release condition on `agent-mode`, for a mechanical reason and not
		// a stylistic one: `agent-mode` is read deployment-wide from the getAllFlags() snapshot with no
		// person attached, so a person-scoped condition on it would match nobody AND would stop the
		// agent model registering at all. One question per key.
		requires: ["agent-mode"],
	},
	{
		key: "router-alias",
		scope: "deployment",
		codeDefault: "off",
		selfHost: { onWhenEnv: ["LLM_ROUTER_ROUTES_PATH"] },
		class: "feature",
		owner: "chat",
		gates:
			"the Omni LLM-router alias at models[0] (modelGates.ts, read from models.ts maybeAddRouterAlias). It takes the picker default with it, which is why it is a flag and not a string",
		whenAbsent:
			"no alias, regardless of LLM_ROUTER_ROUTES_PATH — that path is config now, and a flag ON with no path is a loud misconfiguration rather than a silent off",
		ticket: "CUR-257",
	},
	{
		key: "guard-primary",
		safety: true,
		scope: "account",
		codeDefault: "off",
		selfHost: "off",
		class: "migration",
		owner: "trust-and-safety",
		expires: "2026-12-31",
		gates:
			"nothing in this build: the guard screens every chat turn (guardGate.ts resolveTurnPolicy) and Coop is only the REVIEW plane. Older builds read it as the SYNC input gate's verdict source (ON: the guard; OFF: Coop), so it stays defined at 100% until no such build can be served (CUR-4802)",
		whenAbsent:
			"no change in this build. An older build that reads it falls back to the Coop gate, which is why it is not archived until those builds are gone",
		ticket: "CUR-490",
	},
	{
		key: "self-harm-distress-declines",
		safety: true,
		scope: "account",
		codeDefault: "off",
		selfHost: "off",
		class: "feature",
		owner: "trust-and-safety",
		gates:
			"whether the chat turn's input screen turns the distress rules (`chat-block-self-harm-intent`, `-passive`, `-hedged`) into blocks (guardGate.ts rulesForScreen, flags from inputScreenFlags, read in routes/chat/conversation/[id]/+server.ts). ON: a person saying they want to die or are hopeless gets the support message and no answer, as before CUR-3915",
		whenAbsent:
			"distress gets Alpha's answer with the Support resources card on top; only a request for a method, a means or a lethal amount (`chat-block-self-harm`) is declined",
		ticket: "CUR-3915",
		specs: { on: "self-harm-hedged.spec.ts", off: "self-harm-hedged.spec.ts" },
		// Answer-plus-card is a product decision, signed off.
		// Turn this ON to restore the declines without a redeploy.
	},
	{
		key: "s1-safety-judge", // gitleaks:allow — a flag key, not a secret
		safety: true,
		scope: "account",
		codeDefault: "off",
		selfHost: { onWhenEnv: ["ZENTROPI_S1_ENDPOINT_URL", "HF_TOKEN"] },
		class: "fix",
		owner: "trust-and-safety",
		expires: "2027-03-31",
		gates:
			"the chat turn's input screen (and output screen, when OUTPUT_MODERATION is on) asking Zentropi S1 (`zentropi-ai/cope-b-s1` on our own Hugging Face Inference Endpoint, `POST /v1/systemone`) to judge every text chunk against the policies in rules-s1.json, in place of Shieldstral's per-rule questions (guardGate.ts inputJudgesFor and s1JudgeFor, detectors/s1.ts, config in web/config/safetyScreen.ts, read in routes/chat/conversation/[id]/+server.ts). Image units stay Shieldstral's. An S1 call that fails or times out leaves its rules unknown and the turn fails closed as today, with no retry",
		whenAbsent:
			"OFF — every turn screens with Shieldstral, as before CUR-4527. The e2e forces the flag with the override cookie",
		ticket: "CUR-4527",
		specs: { on: "s1-safety-judge.spec.ts", off: "s1-safety-judge.spec.ts" },
	},
	{
		key: "mila-sp-output-guard", // gitleaks:allow — a flag key, not a secret
		safety: true,
		specs: { on: "mila-sp-output-guard.spec.ts", off: "mila-sp-output-guard.spec.ts" },
		scope: "account",
		codeDefault: "off",
		selfHost: "off",
		class: "feature",
		owner: "chat",
		gates:
			"the chat turn's check of its finished answer by the Mila suicide-prevention classifier (milaSpOutputGuard.ts, detectors/milaSp.ts, config MILA_SP_GUARD in web/config/safetyScreen.ts, read in routes/chat/conversation/[id]/+server.ts). Only an English or French answer is checked, after it has streamed in full; it is never held, cut or rewritten. On a hit (p(unsafe) >= 0.5 on any 510-token window) the answer stays, the crisis card shows under it, and every later turn in that conversation is refused (Conversation.crisisEndedAt, 403). An endpoint failure or timeout fails OPEN. Separate from OUTPUT_MODERATION",
		whenAbsent:
			"OFF — no answer is checked and no conversation is ended by it. A conversation already ended stays ended, since the refusal reads the saved stamp, not the flag",
		ticket: "CUR-4766",
	},
	{
		key: "guard-history-cap",
		safety: true,
		scope: "account",
		codeDefault: "off",
		selfHost: "off",
		class: "fix",
		owner: "trust-and-safety",
		expires: "2027-03-31",
		gates:
			"the chat turn's input screen reading only the newest user message whole plus the end of the earlier ones, up to SCREEN_HISTORY_CAP (4,000 chars) in total, in place of every user message (capScreenHistory in guardScreenTypes.ts, read in chat/prepareTurnMedia.ts). A newest message of 4,000 chars or more is screened alone. A message further back is not screened again; it passed on its own turn. Production enable is its own ticket",
		whenAbsent:
			"OFF — every turn screens the finalText of every user message, so a long chat splits into several 12,000-char windows and waits on each",
		ticket: "CUR-4764",
		specs: { on: "long-history-decline.spec.ts", off: "long-history-decline.spec.ts" },
	},
	{
		key: "hedge-tool-rounds",
		scope: "account",
		codeDefault: "off",
		selfHost: "on",
		class: "fix",
		owner: "chat",
		expires: "2026-12-31",
		gates:
			"whether a tool turn's later round (the request after a search or a calculation, calculateTool.ts `sendRound`) sends a second copy of its request on the same lane once `TOOL_ROUND_HEDGE_AFTER_MS` (12s) passes with no response headers (CUR-4372). Those rounds go out after the lane is committed, so the first-chunk hedge (failover.ts) never sees them, and a request that hangs without throwing waited out the whole 45s turn and ended in an error. Its own key so it can be turned off without losing round one's hedge; each hedge is one extra request against the provider's shared rate limit",
		whenAbsent:
			"a later round's request waits for its headers until the turn's 45s cap, exactly as before CUR-4372. The round-request start and failure log lines are not gated and log either way",
		ticket: "CUR-4372",
	},
	{
		key: "side-call-own-lane",
		scope: "deployment",
		codeDefault: "off",
		selfHost: { onWhenEnv: ["MISTRAL_MODELS"] },
		class: "feature",
		owner: "chat",
		expires: "2026-12-31",
		gates:
			"whether a side-call model (TASK_MODEL, ARITHMETIC_ROUTE_MODEL, SECOND_OPINION_MODEL) that MISTRAL_MODELS lists registers on the Mistral lane rather than the compare endpoint (models.ts `maybeAddCompareModels`). Needed to move side calls to mistral-small-2603, which the compare endpoint does not serve (CUR-2262)",
		whenAbsent:
			"every side-call model registers on SECOND_OPINION_BASE_URL as before, so a Mistral id there is sent to a provider that does not have it. Production waits on the privacy notice naming Mistral for side calls (CUR-2063)",
		ticket: "CUR-2262",
	},
	{
		key: "provenance-assisted-by",
		scope: "account",
		codeDefault: "off",
		selfHost: "on",
		class: "feature",
		owner: "chat",
		gates:
			"whether a turn records the helper models that worked on it without writing it, the search decision and the math-route planner, as routerMetadata.assistedBy (role, model, host), and X-ray's Step by step names each one with the host it ran on (CUR-984)",
		whenAbsent:
			"the turn records only the model that wrote the answer, and X-ray names no helper model, as before",
		ticket: "CUR-984",
	},
	{
		key: "math-routing",
		scope: "account",
		specs: { on: "math-routing.spec.ts" },
		codeDefault: "off",
		selfHost: { onWhenEnv: ["ARITHMETIC_ROUTE_MODEL", "SECOND_OPINION_BASE_URL", "SECOND_OPINION_API_KEY"] },
		class: "feature",
		owner: "chat",
		gates:
			"the turn planner (turnPlan.ts, mathRouting.ts, wired in conversation/[id]/+server.ts): one forced plan_turn call on ARITHMETIC_ROUTE_MODEL (GLM) on every turn the input screen allows, whose math field says whether the latest message asks for a number to be worked out and records the setup as typed lines. Code sums them and streams the checked rows and total ahead of the answer; on those turns the route model writes the answer too, and every other turn stays on the default model. The ledger carries no \"checked by code\" label (CUR-3663), and any the model copies from an older answer is removed (CUR-2199). When the plan call fails the answer carries no checked total (CUR-2134)",
		whenAbsent:
			"no plan call, no ledger and no stamp stripping: every turn is the default model's prose, exactly as before",
		ticket: "CUR-2198",
	},
	{
		key: "repetition-guard",
		scope: "account",
		codeDefault: "off",
		selfHost: "off",
		class: "fix",
		owner: "chat",
		expires: "2026-12-31",
		gates:
			"the language-agnostic degenerate-repetition probe (repetitionGuard.ts, CUR-1104): when the final answer repeats the same 6-word span 3+ times, replaces it with a fixed honest notice instead of shipping the loop. Wired in honestyStream.ts alongside degeneration.ts's own (observe-only) structural-collapse probe",
		whenAbsent:
			"detectDegenerateRepetition never runs — a degenerate answer ships as-is exactly as it did before CUR-1104. Off until live-verified against real traffic; validated so far only against 3 captured incidents and a hand-built legitimate-answer battery, not production volume",
		ticket: "CUR-1104",
	},
	{
		key: "workspace-org-creation",
		scope: "account",
		specs: { on: "workspaces.spec.ts" },
		codeDefault: "off",
		selfHost: "on",
		class: "feature",
		owner: "chat",
		gates:
			"creating an ADDITIONAL workspace and inviting anyone into one (workspacesGate.ts) — the 'Create another workspace'/'Invite by email' UI and better-auth's organization plugin routes (routes/chat/api/auth/[...all]) — both read this so a hidden option and a reachable route can't disagree. Split from `workspaces` (CUR-957) because seeing your own workspace is a personal-account concept, safe for anyone signed in, while org creation is a privilege Current AI grants to partners after a conversation",
		whenAbsent:
			"creation/invite UI hidden, organization routes 404 — the personal workspace view (on for everyone signed in) still works. This is the intended production state until a partner gate exists",
		ticket: "CUR-957",
	},
	{
		key: "low-resource-language-fallback",
		scope: "account",
		specs: { on: "language-response.spec.ts" },
		codeDefault: "off",
		selfHost: "on",
		class: "feature",
		owner: "chat",
		gates:
			"the honest-fallback short-circuit for Quechua/Yucatec Maya/Tzeltal (languageFallbackGate.ts, called from conversation/[id]/+server.ts before generation)",
		whenAbsent:
			"a match falls through to the normal generation path, same as before CUR-742 landed — the ticket's own accepted false-negative behavior, not a new gap. Off until CUR-742's own open call (native-speaker sign-off) is resolved",
		ticket: "CUR-742",
	},
	{
		key: "low-resource-per-model",
		scope: "account",
		specs: { on: "answer-language-named.spec.ts", off: "answer-language-named.spec.ts" },
		codeDefault: "off",
		selfHost: "on",
		class: "fix",
		owner: "chat",
		expires: "2026-12-31",
		gates:
			"the named-language sentence for a language the model is measured to drift out of, Hausa and Amharic (weakLanguageNote in replyLanguage.ts, appended to the preprompt in textGeneration/index.ts)",
		whenAbsent:
			"the turn keeps the generic reply-language rule only, and the model may answer Hausa in English as before CUR-2237. Production flip tracked on CUR-4090",
		ticket: "CUR-2237",
	},
	{
		key: "entity-name-correction",
		scope: "account",
		codeDefault: "on",
		selfHost: "on",
		class: "fix",
		owner: "chat",
		expires: "2026-12-31",
		gates:
			"the entity-name-correction search branch (CUR-877, entityCorrectionGate.ts): an extra fast-model call plus a second Firecrawl dispatch when a misspelled entity name is detected in a chat search",
		whenAbsent:
			"the branch runs anyway — this flag defaults ON, not off. Unlike workspaces/low-resource-language-fallback, the feature is already live with no documented output concern, so an off-by-default flag would be an unannounced regression, not a safety net. This is a rollback lever, not a rollout gate",
		ticket: "CUR-877",
	},
	{
		key: "source-credibility-filter",
		scope: "account",
		codeDefault: "off",
		selfHost: "on",
		class: "feature",
		owner: "chat",
		expires: "2026-12-31",
		gates:
			"the host screen in retrieveWeb (sourceCredibility.ts, CUR-2423): forum, social and low-credibility pages (WP:RSP and Iffy.news lists) are dropped before the rerank, the evidence labels official and academic sources, and a thin-evidence note is added when fewer than three sources survive",
		whenAbsent:
			"every retrieved page goes to the reranker as before, so a relevant Reddit thread or YouTube video can be cited as evidence, which is the CUR-2423 defect. Production enable: CUR-2564",
		ticket: "CUR-2423",
	},
	{
		key: "search-query-language",
		scope: "account",
		codeDefault: "off",
		selfHost: "on",
		class: "fix",
		owner: "chat",
		expires: "2026-12-31",
		gates:
			"whether a native turn's web_search query that reads as a different non-English language from the person's message (queryLanguage.ts) is sent back once for a rewrite in the person's language before any search runs, so a Catalan question is searched in Catalan (CUR-4376). Costs one model round on such a turn",
		whenAbsent:
			"the model's query is searched as written, so a Catalan question that the model searches in Spanish cites Spanish pages, ticket resellers among them, as before CUR-4376. Production enable: CUR-4379",
		ticket: "CUR-4376",
	},
	{
		key: "custodial-storage-view",
		scope: "account",
		specs: { on: "custodial-storage.spec.ts" },
		codeDefault: "off",
		// Any chosen store, local and s3 as much as hf. custodialStorageGate.ts still
		// withholds the surface when that store's own settings are incomplete.
		selfHost: { onWhenEnv: ["CUSTODIAL_STORAGE_BACKEND"] },
		class: "feature",
		owner: "chat",
		gates:
			"the storage-view surface (custodialStorage.ts): list/upload/download/delete against the deployment's custodial bucket (custodialBucketRepo.ts), scoped per user by custodialBucket.ts's users/<id>/ layout and assertOwnership check",
		whenAbsent:
			"dark — no storage-view route or UI reachable, same as before this ticket. New, not-yet-trusted surface against a shared credential; fails closed if PostHog is ever unreachable, not open",
		ticket: "CUR-899",
	},
	{
		key: "thunderbolt-export",
		scope: "account",
		specs: { on: "thunderbolt-export.spec.ts", off: "thunderbolt-export.spec.ts" },
		codeDefault: "off",
		selfHost: "on",
		class: "feature",
		owner: "chat",
		gates:
			"the account page's \"Move your conversations to Thunderbolt\" row and the route behind it, routes/chat/api/v2/export/thunderbolt (thunderboltExport.ts, CUR-2407): a .json download Thunderbird's Thunderbolt imports. Only on top of data-export",
		whenAbsent: "no row and a 404 from the route; the ZIP export is untouched. Off when PostHog is unreachable",
		ticket: "CUR-2407",
	},
	{
		key: "new-device-notice",
		scope: "account",
		specs: { on: "new-device-notice.spec.ts", off: "new-device-notice.spec.ts" },
		codeDefault: "off",
		selfHost: { onWhenEnv: ["RESEND_API_KEY"] },
		class: "feature",
		owner: "chat",
		gates:
			"the email sent when an account signs in from a device it has not used before (newDeviceNotice.ts, CUR-4181), naming the device and linking to Active sessions",
		whenAbsent:
			"no email; sign-ins behave as before. Off when PostHog is unreachable, so a new mail path stays quiet rather than mailing on a guess",
		ticket: "CUR-4181",
	},
	{
		key: "storage-locations",
		scope: "account",
		specs: { on: "storage-locations.spec.ts", off: "storage-locations.spec.ts" },
		codeDefault: "off",
		selfHost: { onWhenEnv: ["HF_BUCKETS_TOKEN", "HF_BUCKETS_REPO"] },
		class: "feature",
		owner: "chat",
		gates:
			"storage locations (storage/locations/, CUR-2930): linking a Hugging Face bucket of the person's own with a token sealed at rest, choosing where new files go (Alpha storage, a linked bucket, or ask every time), Connect Hugging Face (a storage-only OAuth consent that makes <user>/alpha-files, CUR-2932), and the location switcher in My files. Read only behind custodial-storage-view",
		whenAbsent:
			"dark: My files shows Alpha storage only, the Advanced disclosure has no link form, and every location API answers 404. Production enable: CUR-2933",
		ticket: "CUR-2930",
	},
	{
		key: "document-attachments",
		// Per account: a PDF or DOCX is opened in-process only for a selected (team) account, in chat
		// and in My files, until the sandboxed parser lands.
		scope: "account",
		specs: { on: "document-attachments.spec.ts", off: "document-attachments.spec.ts" },
		codeDefault: "off",
		selfHost: "on",
		class: "feature",
		owner: "chat",
		gates:
			"PDF and DOCX chat attachments read to text on the server and screened with the turn (documentAttachmentsGate.ts, prepareTurnMedia.ts), offered only when multimodal is also on; any PDF or DOCX, in chat or My files, opened to hash-scan its pictures (embeddedImageScan.ts)",
		whenAbsent:
			"dark — the composer offers no PDF or DOCX, and one that arrives anyway is refused unopened, in chat and in My files",
		ticket: "CUR-987",
	},
	{
		key: "attachment-allowance",
		// Per account; a guest reads the deployment's answer. An ops switch on a new limit: the numbers
		// are in uploadLimits.ts, and whether a file past them is refused or only logged is decided here.
		scope: "account",
		specs: { on: "custodial-storage.spec.ts", off: "custodial-storage.spec.ts" },
		codeDefault: "off",
		selfHost: "on",
		class: "fix",
		owner: "chat",
		expires: "2026-12-31",
		gates:
			"refusing a chat attachment past the rolling 24-hour allowance (attachmentAllowance.ts, CUR-3235): GET /chat/api/attachment-allowance answers what is left so the composer refuses at attach, and parseRequest answers 413 at send. Counting runs either way",
		whenAbsent:
			"every attachment is counted and stored; one past the allowance logs `[attachment-allowance] would refuse` instead of being refused. Production enable: CUR-3600",
		ticket: "CUR-3235",
	},
	{
		key: "document-text-only",
		// Per account, and read only where `document-attachments` does not select the account.
		scope: "account",
		specs: { on: "document-attachments.spec.ts", off: "document-attachments.spec.ts" },
		codeDefault: "off",
		selfHost: "off",
		class: "feature",
		owner: "chat",
		gates:
			"the text-only workaround while pictures in documents cannot be scanned for everyone: a PDF or DOCX from an account outside document-attachments is read for its text in parseRequest.ts, and only a .txt of that text is stored; the original bytes and its pictures are never stored (storage/documentTextOnly.ts)",
		whenAbsent:
			"dark — a PDF or DOCX from an account outside document-attachments is refused unopened, as before",
		ticket: "CUR-987",
	},
	{
		key: "folkways-adapter",
		scope: "deployment",
		codeDefault: "env",
		selfHost: { onWhenEnv: ["FOLKWAYS_ENABLED", "FOLKWAYS_URL"] },
		class: "feature",
		owner: "chat",
		gates:
			"every route under routes/folkways-adapter (v1/chat/completions, v1/models, v1/safety): the Folkways control-plane adapter that, as OPENAI_BASE_URL, observes or rewrites each chat request and reports prompts/safety/traces to the Folkways server",
		whenAbsent:
			"falls back to FOLKWAYS_ENABLED (unset or 0 → every adapter route 404s), so an unconfigured deployment behaves as if the adapter did not exist",
		ticket: "CUR-616",
	},
	{
		key: "mcp-elicitation",
		scope: "account",
		class: "feature",
		codeDefault: "off",
		selfHost: "off",
		owner: "chat",
		gates:
			"whether the MCP client advertises the `elicitation` capability at all (mcp/elicitationConfig.ts, CUR-1017) — a server never sees the capability to use it while this is off, so nothing downstream of it can fire either",
		whenAbsent:
			"the capability is never advertised, same as before CUR-1017. No live MCP server would exercise it today in any case — the one configured Space is TTS-only",
		ticket: "CUR-1017",
		// elicitationConfig.ts reads this key. Registering it here, and in flagKeys.spec.ts's
		// GATE_CONSTANTS, is what lets refreshFlags reconcile it against PostHog and report it missing
		// when PostHog has no `mcp-elicitation` flag.
	},
	{
		key: "mcp-servers",
		scope: "account",
		class: "feature",
		codeDefault: "off",
		selfHost: "off",
		owner: "chat",
		gates:
			"whether the tools of the operator-configured MCP servers (MCP_SERVERS, mcp/servers.ts), and of servers a signed-in person added in Settings → Connectors (CUR-4016), are offered on a chat turn: in the tool loop for a model that calls tools, through the router pre-pass otherwise. A tool not marked readOnlyHint runs only after the person allows it",
		whenAbsent:
			"no configured server is contacted and no tool of theirs is offered",
		ticket: "CUR-3026",
		specs: { on: "mcp-servers.spec.ts", off: "mcp-servers.spec.ts" },
		// Production enable is its own ticket and a flag flip.
	},
	{
		key: "one-chat-sandbox",
		scope: "account",
		class: "feature",
		codeDefault: "off",
		selfHost: { onWhenEnv: ["AGENT_SERVICE_URL", "AGENT_SERVICE_TOKEN"] },
		owner: "chat",
		gates:
			"whether a native chat turn gets the conversation's sandbox as MCP tools (sandbox__run_code, run_command, read_file, write_file, list_files; mcp/sandboxServer.ts), served by agent-service at /mcp/ with no network. They run without a confirmation card unless the person set one to ask or never in Settings → Connectors",
		whenAbsent:
			"no sandbox tool is offered and agent-service's /mcp/ route is never called; a chat turn has web search and calculate only, as before",
		ticket: "CUR-4232",
		specs: { on: "one-chat-sandbox.spec.ts", off: "one-chat-sandbox.spec.ts" },
	},
	{
		key: "chat-agent-handoff",
		scope: "account",
		class: "feature",
		codeDefault: "off",
		selfHost: { onWhenEnv: ["AGENT_SERVICE_URL", "AGENT_SERVICE_TOKEN"] },
		owner: "chat",
		gates:
			"whether a native turn that has the sandbox also gets hand_off_to_agent and check_agent_task (mcp/handoffKit.ts): after the person confirms on a card, the task goes to an agent-service /run in the same workdir, and its answer comes back into the turn",
		whenAbsent:
			"neither tool is offered and no /run is started from a chat turn; the sandbox's own tools are unchanged",
		ticket: "CUR-4388",
		specs: { on: "chat-agent-handoff.spec.ts", off: "chat-agent-handoff.spec.ts" },
	},
	{
		key: "reply-language-rule",
		scope: "account",
		class: "fix",
		codeDefault: "on",
		selfHost: "on",
		owner: "chat",
		expires: "2026-12-31",
		gates:
			"the in-language reply rule injected into the user turn by guardFor() (textGeneration/grounding.ts, read via textGeneration/replyLanguageGate.ts) — the instruction to write every sentence of the answer, including any identity sentence, in the language of the question",
		whenAbsent:
			"the rule is INCLUDED. Default-on because it repairs a live defect: without the rule, answers to questions asked in another language came back in English, most visibly the ones that open by stating the assistant's identity. Turning this off restores the pre-CUR-1430 prompt, whose only language instruction sat mid-paragraph in the under-weighted system role and read \"(default English)\". Creating this flag with a preview-only release condition would turn the fix OFF in production and ship the defect — see replyLanguageGate.ts",
		ticket: "CUR-1430",
	},
	{
		key: "loop-cut",
		scope: "account",
		class: "fix",
		codeDefault: "on",
		selfHost: "on",
		owner: "chat",
		expires: "2026-12-31",
		gates:
			"the mid-stream repetition cut (textGeneration/loopCut.ts, wired in conversation/[id]/+server.ts ahead of the output screen) — once the last 60 words outside a code fence add six or fewer six-word spans new to the answer, generation stops and the answer ends with the fixed repetition notice",
		whenAbsent:
			"the cut is ON. Default-on because it repairs a live defect: a model can repeat a phrase in a loop for thousands of characters, and the output screen then reads all of it and may decline the answer on the repeated text. The cut caps the repeat. Turning this off lets a looping answer stream in full again",
		ticket: "CUR-3318",
	},
	{
		key: "provenance-facts-per-turn",
		scope: "account",
		class: "fix",
		codeDefault: "off",
		selfHost: "on",
		owner: "chat",
		expires: "2026-12-31",
		gates:
			"per-turn provenance facts (textGeneration/provenanceFacts.ts) injected into the user turn on every turn, built from the conversation's model, the lane, and the previous answer's measured backend; the persona's {serving} sentence then points at those facts instead of asserting where the model runs",
		whenAbsent:
			"the persona asserts a serving sentence written before the gateway picks a backend (servingClause), and grounding.ts adds its serving note only when isServingQuery's word list matches, so \"which model are you, and who runs it?\" gets the pre-request guess (CUR-2135)",
		ticket: "CUR-1435",
		verified: {
			on: "2026-09-27",
			evidence:
				"the provenance-facts probe (then scripts/provenance-facts-probe.mjs, now evals/inspect_tasks/provenance_facts.py) --repeat 2 on a local dev server (gateway lane), arms switched by fuzz_override: " +
				"\"sovereign\" in the identity answer 3/6 off (one on a Featherless-served turn) vs 0/6 on; facts leaked into the unrelated first answer 0/6 on",
			servedBy: "swiss-ai/apertus-v1.5-70b",
		},
	},
	{
		key: "identity-provider-stamp",
		scope: "account",
		class: "fix",
		codeDefault: "off",
		selfHost: "on",
		owner: "chat",
		expires: "2026-12-31",
		gates:
			"the self-identity verdict (selfIdentity.ts, a multilingual embedding margin) that vetoes a web search on a question about the assistant itself. It also appended a routing-record line to such answers until CUR-2921 moved that record into X-ray's \"Where it ran\", which shows on every turn with no flag. Production enable: CUR-2303",
		whenAbsent:
			"no verdict is computed, so the English-only search gate alone decides, and a question about the assistant in another language can be sent to the web (CUR-2135)",
		ticket: "CUR-2135",
	},
	{
		key: "length-first-brevity",
		scope: "account",
		class: "fix",
		codeDefault: "off",
		selfHost: "off",
		owner: "chat",
		expires: "2026-12-31",
		gates:
			"the wording of guardFor()'s brevity sentence (textGeneration/grounding.ts, read via textGeneration/lengthFirstBrevityGate.ts): on, a requested length or long document comes first and the \"not a long essay\" contrast is dropped",
		whenAbsent:
			"today's wording, \"Answer concisely by default … not a long essay\", which a model can quote back verbatim when it refuses a long-guide request. Enabling it in production is CUR-2127",
		ticket: "CUR-2126",
	},
	{
		key: "cms-snapshot-seed",
		scope: "deployment",
		class: "fix",
		codeDefault: "off",
		selfHost: "off",
		owner: "site",
		expires: "2026-12-31",
		gates:
			"whether a page read the cache has no value for serves the build-time CMS snapshot at once and fetches the live CMS in the background (payload/cached-client.ts, cms-snapshot.json)",
		// A cold instance has not polled PostHog yet, so this reads its fallback exactly when it matters
		// most. The deadline in swrFetch is what bounds a cold render either way; this flag only removes
		// the wait up to it on an instance that has polled.
		whenAbsent:
			"a missed read waits on the live CMS for up to the 1s deadline, then gets the snapshot or the last cached value. Enabling it in production is CUR-2248",
		ticket: "CUR-2099",
	},
	{
		key: "auto-routing",
		scope: "account",
		class: "feature",
		codeDefault: "off",
		selfHost: "on",
		owner: "chat",
		gates:
			"'Auto' as a model choice: the Auto row in the composer's model menu, the live language and effort read of the draft, and Auto as the choice that resolves a new chat's model (autoRoutingGate.ts, shipped in the layout data as autoRoutingEnabled and read by ChatLanding.svelte and ChatComposerFrame.svelte)",
		whenAbsent:
			"OFF — no Auto row, no reading of the draft, and a new chat starts on the model chosen in settings (or the first model), as it did before Auto existed. Fails closed if PostHog is unreachable. Turning it on does not expose the routing lab, where Auto's ranking is tuned: that page is developer-only and the composer does not link to it",
		ticket: "CUR-1380",
	},
	{
		key: "agent-run-handoff",
		scope: "deployment",
		specs: { on: "agent-run-outlives-the-request.spec.ts", off: "agent-outlives-the-tab.spec.ts" },
		class: "feature",
		codeDefault: "off",
		selfHost: { onWhenEnv: ["AGENT_SERVICE_URL", "AGENT_SERVICE_TOKEN"] },
		owner: "chat",
		gates:
			"An agent run outliving the chat request (agentRunHandoffGate.ts, read when a run is submitted and stored on it as agentRun.handoff). On, an agent turn asks agent-service for its whole 300s attempt instead of 150s, hands the run to the page about 15s before the route's watchdog (the answer is stored interrupted with the run open), and the page that sent it re-attaches until the run ends, for up to every attempt the service may make",
		whenAbsent:
			"OFF: an agent run is asked to stop at 150s and the turn ends at the 155s watchdog, as before. Fails closed if PostHog is unreachable. Enabling it in production is CUR-4685",
		ticket: "CUR-4410",
	},
	{
		key: "auto-repick",
		scope: "deployment",
		specs: { on: "auto-repick.spec.ts", off: "auto-repick.spec.ts" },
		class: "feature",
		codeDefault: "off",
		selfHost: "on",
		owner: "chat",
		gates:
			"Auto picking again inside a turn its first choice did not answer (autoRepickGate.ts, shipped in the layout data as autoRepickEnabled). On, a model Auto chose gives up after 20s of silence instead of the 45s watchdog, and when an Auto turn fails on a 429 or on silence before any text the conversation page runs Auto again without that model and resends the question over the failed answer, with Auto's note naming the model it replaced. A hand-picked model is never re-picked",
		whenAbsent:
			"OFF: an Auto turn whose model is busy or silent ends on that model's error, and Auto routes around it only on the next send. Fails closed if PostHog is unreachable. Enabling it in production is CUR-4384's last Done-when item",
		ticket: "CUR-4384",
	},
	{
		key: "clef-routing",
		scope: "account",
		class: "feature",
		codeDefault: "off",
		selfHost: { onWhenEnv: ["CLEF_BASE_URL", "CLEF_API_KEY"] },
		owner: "chat",
		gates:
			"Auto's hosted draft read (clefRoutingGate.ts): after a pause in typing the composer posts the draft to /chat/api/routing/classify, which asks Clef on the Potluck router (CLEF_BASE_URL) for language, task size and skills, and merges that over the local read (routing/clef.ts). Shipped in the layout data as clefRoutingEnabled. Needs auto-routing on as well",
		whenAbsent:
			"OFF: Auto reads the draft in the browser only, nothing typed leaves the device before sending, and the classify route 404s. Fails closed if PostHog is unreachable",
		ticket: "CUR-1380",
	},
	{
		key: "account-rollout-probe",
		scope: "account",
		class: "probe",
		codeDefault: "off",
		selfHost: "off",
		owner: "chat",
		expires: "2026-12-31",
		gates:
			"nothing a visitor sees: when on for a request, hooks/handle.ts sets x-account-rollout-probe on the response (accountRolloutProbe.ts). Its preview condition is env = preview AND email matches @example\\.org$, the domain every e2e account uses, so account-rollout.spec.ts can prove a person-property condition reaches a signed-in account and not an anonymous visitor",
		whenAbsent: "no header on any response, so account-rollout.spec.ts fails its signed-in assertion",
		ticket: "CUR-2463",
	},
	{
		key: "report-fanout",
		scope: "account",
		class: "feature",
		codeDefault: "off",
		selfHost: { onWhenEnv: ["REPORT_SLACK_WEBHOOK"] },
		owner: "chat",
		gates:
			"posting a saved answer report to Slack (a link to its admin-page anchor, never the answer) and to Linear (one issue per reporter per two minutes, later reports add a count) — reportFanout.ts, called from the report route after saveReport",
		whenAbsent:
			"OFF — reports are saved and forwarded to Coop as before, and nothing goes to Slack or Linear. Enabling it in production is CUR-2404",
		ticket: "CUR-997",
	},
	{
		key: "past-chat-search",
		scope: "account",
		specs: { on: "past-chat-search.spec.ts", off: "memory-coming-soon.spec.ts" },
		codeDefault: "off",
		selfHost: "on",
		class: "feature",
		owner: "chat",
		gates:
			"Settings → Personalization's \"Search my past chats\" switch and, for a signed-in person who switches it on, the native turn's search_past_chats tool: BM25 over that account's own earlier chats (rag/pastChats.ts, scoped by user_id), with a \"Used your past chats\" note under the answer (CUR-4576)",
		whenAbsent:
			"dark: no switch in Personalization, no tool on any turn, and the prompt says the model sees this conversation only, as before CUR-4576. Production enable: CUR-4581",
		ticket: "CUR-4576",
	},
	{
		key: "stream-follow",
		scope: "deployment",
		specs: { on: "stream-resumes-mid-answer.spec.ts", off: "stream-resumes-mid-answer.spec.ts" },
		codeDefault: "off",
		selfHost: "on",
		class: "feature",
		owner: "chat",
		gates:
			"a plain turn recording what its stream sent into generation_events (chat/generationLog.ts) and GET /chat/conversation/[id]/generation/[generationId] answering a follow (404 when off); the page follows a dropped turn through it before falling back to the saved-copy poller (CUR-4716)",
		whenAbsent:
			"dark: no turn writes the log, the follow route answers 404, and a dropped stream waits for the saved copy. Production enable is its own ticket",
		ticket: "CUR-4716",
	},
	{
		key: "share-links",
		scope: "account",
		specs: { on: "share-link.spec.ts", off: "share-link.spec.ts" },
		codeDefault: "off",
		selfHost: "off",
		class: "feature",
		owner: "chat",
		gates:
			"read-only share links (shareLinksGate.ts): the \"Share chat\" row in a conversation's menu, the share API (api/v2/conversations/[id]/share, api/v2/shares), the Shared links list in Settings → Data & privacy, and the signed-out viewer at /r/<id>, which reads the deployment snapshot (CUR-2632)",
		whenAbsent:
			"dark: no Share chat row, the share API and the viewer answer 404, and existing links stop opening until it is back on. Production enable: CUR-4882",
		ticket: "CUR-2632",
	},
	{
		key: "history-key-enrollment",
		scope: "account",
		specs: { on: "history-key-enrollment.spec.ts", off: "history-key-enrollment.spec.ts" },
		codeDefault: "off",
		selfHost: "off",
		class: "feature",
		owner: "chat",
		gates:
			"enrolling and unlocking the conversation-history key in the browser (historyKeyGate.ts, the browser-key stage of history sealing): a guest's silent device key on the first turn, the signed-in recovery step (recovery key, passkey where PRF works, or accepting loss), the unlock prompt in a browser with no device key, and Settings → Account → Your key. Withheld, with an error logged, on a deployment with no custodial storage",
		whenAbsent:
			"dark: no device key is made, no recovery step or unlock prompt shows, and Your key is not in Settings. Nothing is sealed before stage 3, so history reads as it does today. Production enable is its own ticket",
		ticket: "CUR-4939",
	},
	{
		key: "conversation-expiry",
		// Deployment: the sweep runs in a cron with no account, and every visitor on one deployment lives
		// under the same retention rule, so one answer per deployment is the only coherent one.
		scope: "deployment",
		specs: { on: "conversation-expiry.spec.ts", off: "conversation-expiry.spec.ts" },
		codeDefault: "off",
		// A self-hosted install keeps conversations until their owner deletes them (the self-host
		// default); `ALPHA_FLAGS=+conversation-expiry` opts one in.
		selfHost: "off",
		class: "feature",
		owner: "chat",
		gates:
			"conversation expiry (conversationExpiry.ts): the daily cleanup cron deleting every conversation (signed in or a guest's, pinned and sealed included) and every My files file 30 days after it was created (or after launch day, for one that predates it), the composer's preview line linking export and self-hosting, each chat's days-left badge, and from day 23 the delete-date banner with Export and Continue in a new chat (POST conversations/[id]/continue). Off, the cron refuses to delete, clears the launch marker, keeps the older guest sweep by last activity, and logs counts by age only",
		whenAbsent:
			"off: no signed-in conversation or file is deleted by age, guests keep the 30-days-since-last-activity sweep, no line, badge or banner shows, Continue answers 404, and the cron only logs what it would delete. Production enable is its own ticket",
		ticket: "CUR-4990",
	},
	{
		key: "history-seal-writes",
		scope: "account",
		specs: { on: "history-seal-writes-flag.spec.ts", off: "history-seal-writes-flag.spec.ts" },
		codeDefault: "off",
		selfHost: "off",
		class: "feature",
		owner: "chat",
		gates:
			"sealing conversation writes to the owner's history key (sealedTurn.ts `conversationSealWritesOn`, the write-sealing stage of history sealing): each new turn, title and preprompt, the backfill, the Open WebUI import and sealing a person's existing chats when they enroll. A chat already sealed keeps sealing with the flag off. On with no custodial storage, a write fails loudly with `history-seal-no-storage`",
		whenAbsent:
			"off: new chats are written in plaintext as before; already sealed chats stay sealed. Production enable is its own ticket",
		ticket: "CUR-5015",
	},
	// Deliberately NOT here: `disable_fallbacks` on the answer lane (gatewayFallbackGate.ts,
	//). It reads no PostHog flag, for the reason a flag would have to be created to be
	// useful: a preview-only release condition switches it OFF in production and ships the defect
	// back (flagEnabledOr falls back only on a key PostHog does not define at all), and a
	// production group at 100% is a production flag decision. Unconditional on the answer lane is
	// the honest shape; rolling it back is a one-line revert.
	//
	// Deliberately NOT here: the local (LAN/self-hosted) inference endpoint feature
	// (localEndpointsGate.ts) reads no PostHog flag — see that file's header for why it follows
	// agentMode.ts's deployment-plane precedent (a plain deployEnv() === "preview" check) instead.
]);

/**
 * Every key this registry declares, as a type. `setFlagOverrides` (e2e/scenarios/helpers/flagOverride.ts)
 * takes `Partial<Record<FlagKey, boolean>>`, so a spec forcing a key that left this list is a type
 * error instead of a setup that silently does nothing.
 */
export type FlagKey = (typeof FLAG_KEYS)[number]["key"];

/** Just the keys, for set comparison against a poll result. */
export const FLAG_KEY_NAMES: string[] = FLAG_KEYS.map((f) => f.key);


/** Keys `flagEnabledOr` always answers from the deployment snapshot. See FlagScope. */
export const DEPLOYMENT_SCOPED_FLAG_KEYS: ReadonlySet<string> = new Set(
	FLAG_KEYS.filter((f) => f.scope === "deployment").map((f) => f.key)
);
