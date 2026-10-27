// @ts-nocheck — plain-JS data manifest (key map + trivial helpers); not worth type-checking, and
// it's imported by both the Vite/app build and the Node scripts, so it stays dependency-free JS.
// config/env-manifest.mjs — SINGLE SOURCE OF TRUTH for every config key the app reads.
// Consumers: scripts/gen-env-ci.mjs (regenerates .env.ci), scripts/check-prod-env.mjs (CI
// deploy gate), src/lib/chat/server/env/validate.ts (boot validation). EDIT HERE — never hand-edit
// .env.ci (it is generated from this). Add a key the code reads -> add it here -> `npm run env:gen`.
//
// Per-key flags (all optional, default false):
//   req:    hard-required in prod — the CI deploy gate and server boot FAIL if it is missing/empty.
//   warn:   soft-required — logged loudly at boot + flagged (non-fatal) by the deploy gate.
//   secret: a credential (auto-set from the name); the gate checks presence, never the value.
//   pub:    client-exposed (PUBLIC_ prefix). Derived, listed for clarity.
//   desc:   one-line note (why it matters / what breaks without it).
//
// ── INFERENCE TOPOLOGY (roles × endpoints × tokens × models) ─────────────────────────────────────
// Inference here is a MATRIX, not one provider/model. Each leg below has its OWN base-URL, token, and
// model var — never carry one leg's endpoint/token/model to another, and verify current values live
// (they differ per deployment). Role → (base-URL var | key var | model var):
//   Primary chat        OPENAI_BASE_URL | OPENAI_API_KEY | config/inference.ts PICKER (MODEL_ALLOWLIST off Vercel) / MODELS
//   World-model verifier ⚠️ reuses OPENAI_BASE_URL | OPENAI_API_KEY→HF_TOKEN | WORLD_MODEL_VERIFIER_MODEL (OLMo; not a manifest key, read via Reflect.get)
//   RAG embeddings      RAG_EMBEDDING_BASE_URL | HF_RAG_EMBEDDINGS_TOKEN | RAG_EMBEDDING_MODEL / RAG_VISION_MODEL
//   Rerank              RERANK_ENDPOINT_URL (tei, wins) / RERANK_BASE_URL (cohere) / RERANK_HF_BASE_URL (hf)
//                       | RERANK_ENDPOINT_TOKEN → RERANK_HF_TOKEN → HF_RAG_EMBEDDINGS_TOKEN → HF_TOKEN (fallback
//                       chain, see rerankTeiToken in rerank.ts) | RERANK_MODEL   (RERANK_BILL_TO, RERANK_KIND)
//   Second opinion      SECOND_OPINION_BASE_URL | SECOND_OPINION_API_KEY | SECOND_OPINION_MODEL
//   Draft classifier    CLEF_BASE_URL | CLEF_API_KEY | CLEF_MODEL   (Clef on the Potluck router, read by
//                       routes/chat/api/routing/classify only while the clef-routing flag is on)
//   Transcription/TTS   TRANSCRIPTION_BASE_URL | (HF token) | TRANSCRIPTION_MODEL
//   LLM router (Omni)   LLM_ROUTER_ROUTES_PATH | — | LLM_ROUTER_*_MODEL   (Arch-Router selection layer)
//   Safety screen       GUARD_SHADOW_URL | HF_TOKEN||OPENAI_API_KEY (+HF_BILL_TO) | fixed constant
//                       (Shieldstral-1.0-3B, the SYNC input gate — every message reaches it, and it is
//                       what declines a turn. The var name is historical.)
//   Moderation (Coop)   COOP_URL | COOP_API_KEY | —   (separate service, NOT an OpenAI-compatible LLM leg.
//                       HIT-ONLY (CUR-942): Coop receives a /report when the screen above flags
//                       something, NOT every turn — guardGate.ts:7, moderation.ts:216.)
// The primary leg's endpoint and key differ between deployments, so read the live value rather than
//   trusting a note (including this one). Every lane is served by the LiteLLM gateway
//   gateway, with dev and prod on separate credentials. MODEL_ALLOWLIST names
//   Apertus 1.5, and every eval, spec and turn resolves the same id from it.
//   ⚠️ A direct CSCS lane and the gateway CASE their model ids differently — CSCS
//      `apertus-ai/Apertus-v1.5-70B`, gateway `swiss-ai/apertus-v1.5-70b` — and selectAllowedModels
//      matches ids EXACTLY (modelsCatalog.ts:29). A retyped id matches nothing, buildModels() throws,
//      and the deployment is hard-down (CUR-139). Copy ids from a live /v1/models response, never
//      from another config.
//   ⚠️ /v1/models is scoped PER CREDENTIAL. "The gateway doesn't have model X" is a claim about the
//      key unless two keys were compared.
// WORLD-MODEL VERIFIER — it reads OPENAI_BASE_URL for its OLMo call, and the gateway serves
//   `allenai/Olmo-3-7B-Instruct` (finish_reason "stop" on the prod credential), so the verifier needs
//   no base-URL of its own. WORLD_MODEL_PREPASS is gated off pending a full harness re-run, and
//   WORLD_MODEL_VERIFIER_MODEL is unset.
//
// ── DATABASE_URL: Preview vs Production are DIFFERENT Neon branches, not just different values ────
// Vercel holds separate DATABASE_URL entries per environment. Non-production Neon branches
// auto-suspend on idle, so a Preview cold boot to first response byte on /chat/conversation/[id]
// (about 6-7s) pays a compute cold start on top of the Vercel function's own, while Production's
// branch stays warm from steady traffic (about 1.6-1.8s). The client's connect-establishment timeout (3.5s, see CONNECT_TIMEOUT_MS in
// messageUpdates.ts) therefore fires and retries on Preview but never on Production.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export const ENV_MANIFEST = {
	AGENT_GENERATION_TIMEOUT_MS: {
		desc: "Watchdog for an agent-mode turn, in ms. Default 155000, which is also the ceiling: a larger value is clamped (see deadlineLadder.ts). Needs a redeploy to change.",
	},
	AGENT_SERVICE_DISPLAY_NAME: {
		desc: "Name shown for the agent model in provenance views.",
	},
	AGENT_SERVICE_MODEL: {
		desc: "Model id shown for agent turns. Unset, the agent service reports it at run time.",
	},
	AGENT_SERVICE_TOKEN: {
		secret: true,
		desc: "Bearer token the app sends to the agent service.",
	},
	AGENT_SERVICE_URL: {
		desc: "Base URL of the agent service (agent-service/). An address, not a switch: the agent-mode flag decides whether agent mode is on, and the flag on with this unset is logged as a misconfiguration and agent mode is withheld.",
	},
	AXIOM_DATASET: {
		desc: "Axiom dataset the app sends its logs to, alongside stdout. Set together with AXIOM_TOKEN; one without the other is reported on stderr and nothing is shipped. scripts/axiom-alert.mjs queries the same dataset.",
	},
	AXIOM_INGEST_URL: {
		desc: "Axiom ingest edge URL, when the datasets live on an edge other than Axiom's default. Unset, ingest goes to api.axiom.co.",
	},
	AXIOM_SECURITY_DATASET: {
		desc: "Axiom dataset for security events (sign-ins, rate-limit trips, refused email sends, blocked fetches). Set together with AXIOM_SECURITY_TOKEN. Unset, security events go to the ordinary log.",
	},
	AXIOM_SECURITY_TOKEN: {
		secret: true,
		desc: "Axiom ingest token for AXIOM_SECURITY_DATASET only.",
	},
	AXIOM_TOKEN: {
		secret: true,
		desc: "Axiom token with ingest permission on AXIOM_DATASET; a query-only token fails ingest. Unset, logs go to stdout only.",
	},
	AXIOM_ALERT_QUERY_TOKEN: {
		secret: true,
		desc: "Query-only Axiom token for scripts/axiom-alert.mjs and the release-soak scripts. The app does not read it.",
	},
	AGGREGATOR_MODEL: {
		desc: "Model that writes the second-opinion verdict. Off a Vercel deployment only; on Vercel, config/inference.ts decides.",
	},
	ALLOW_IFRAME: {
		desc: "\"true\" allows the app to be embedded in an iframe on other sites. Read at build time by svelte.config.js.",
	},
	ALLOW_INSECURE_COOKIES: {
		desc: "\"true\" sends session cookies without the Secure attribute. For local HTTP only.",
	},
	APP_BASE: {
		desc: "Kept from upstream chat-ui. Nothing in the app reads it; scripts/updateLocalEnv.ts only lists it.",
	},
	ARITHMETIC_ROUTE_MODEL: {
		desc: "Model that plans each turn and answers arithmetic, when the math-routing flag is on; unset, those turns stay on the default model. Off a Vercel deployment only; on Vercel, config/inference.ts decides.",
	},
	AUTOMATIC_LOGIN: {
		desc: "\"true\" makes sign-in mandatory.",
	},
	// Better Auth's session/cookie signing key (CUR-434). Not req:true: that would hard-crash local dev
	// boot for anyone without it in their personal Doppler config. warn:true instead, because the
	// better-auth-signin flag gates only the /chat/login redirect, not the /chat/api/auth/* routes,
	// which are always mounted and reachable directly. An unset or rotated value in prd/preview must
	// be loud, not silent.
	BETTER_AUTH_SECRET: {
		secret: true,
		warn: true,
		desc: "Signing secret for sessions. Set it in every shared environment: the auth routes are mounted whatever the sign-in flag says, and a missing or rotated value signs everyone out.",
	},
	// External dead-man's switch for the warm cron (CUR-102). Better Stack alerts when pings STOP, so
	// this is the check-on-the-checker that survives us being down. PROD ONLY — sharing one heartbeat
	// with preview would let preview hold it green while prod is dead.
	BETTERSTACK_HEARTBEAT_URL: {
		secret: true,
		desc: "Uptime heartbeat URL pinged by the warm-up job, so an outside monitor alerts when the pings stop. Production only: a preview sharing it could keep it green while production is down.",
	},
	// Per-dependency heartbeats behind the PUBLIC status page's four capability components (CUR-102).
	// recordProbe pings these ONLY on a healthy probe, so a failing dependency reds by silence. PROD ONLY
	// for the same reason as the switch above. Grace period must be >= FIRE_THRESHOLD × slowest probe
	// interval, or a throttled-but-healthy probe reds a component — see alerting.ts.
	// Component "Chat responses":
	BETTERSTACK_HB_MODEL_URL: {
		secret: true,
		desc: "Uptime heartbeat URL pinged when the model check passes. Production only.",
	},
	// Component "Search & retrieval":
	BETTERSTACK_HB_EMBEDDINGS_URL: {
		secret: true,
		desc: "Uptime heartbeat URL pinged when the embeddings check passes. Production only.",
	},
	BETTERSTACK_HB_CATALOG_URL: {
		secret: true,
		desc: "Uptime heartbeat URL pinged when the model catalog check passes. Production only.",
	},
	// Component "Safety filtering":
	BETTERSTACK_HB_COOP_URL: {
		secret: true,
		desc: "Uptime heartbeat URL pinged when the moderation service check passes. Production only.",
	},
	BETTERSTACK_HB_DECLINES_URL: {
		secret: true,
		desc: "Uptime heartbeat URL pinged while moderation is not failing closed. Production only.",
	},
	// Component "Conversation history":
	BETTERSTACK_HB_DB_URL: {
		secret: true,
		desc: "Uptime heartbeat URL pinged when the database check passes. Production only.",
	},
	BODY_SIZE_LIMIT: {
		desc: "Maximum request body size, read only by SvelteKit's Node adapter. The Vercel build does not read it.",
	},
	CSAM_SCAN_BASE_URL: {
		desc: "Base URL of the known-CSAM hash check (an HMA instance) run on every chat and My files upload. Uploads fail closed on it: unset, no attach control is offered and any upload is refused; if the check cannot be reached, the file is refused and the turn's text is still answered; a match refuses the upload, alerts and reports to Coop. Local stack: web/hma/.",
	},
	CSAM_SCAN_TOKEN: {
		secret: true,
		desc: "Bearer token for the proxy in front of the hash check. A wrong or missing token looks the same as a scanner that cannot be reached, so uploads are refused. Not needed for the local web/hma/ stack.",
	},
	CHALLENGE_REDERIVE_ENABLED: {
		desc: "\"true\" makes the model re-derive an answer the user challenges instead of conceding. Default off.",
	},
	CI_HERMETIC: {
		desc: "Test only: \"true\" skips the live model catalog at boot and stops stateful Vitest at the first failure. Set by the pnpm test:ci scripts.",
	},
	CLEF_API_KEY: {
		secret: true,
		desc: "Key for Auto's hosted draft classifier at CLEF_BASE_URL.",
	},
	CLEF_BASE_URL: {
		desc: "Base URL of Auto's hosted draft classifier; the model name is appended to it. The clef-routing flag turns it on, and the flag on with this or CLEF_API_KEY unset is logged as a misconfiguration.",
	},
	CLEF_MODEL: {
		desc: "Which hosted classifier answers: \"clef\" (default) or \"clef-flash\".",
	},
	// Value must match Payload's own CMS_PREVIEW_SECRET (different var name, same repo) — gates
	// draft-content fetches. Checked directly against the `?preview=` query param Payload's
	// generatePreviewURL embeds in its Live Preview/Preview URLs ([...slug]/+page.server.ts), and
	// sent back to Payload's REST API as the `x-preview-secret` header so its own access.read
	// (readWithDraftSecret.ts) allows the draft read too — without that header, Payload's public
	// access.read still refuses ?draft=true.
	CMS_PREVIEW_SECRET: {
		secret: true,
		desc: "Shared secret for Payload CMS draft previews. Must match the CMS's own CMS_PREVIEW_SECRET; checked against the ?preview= parameter and forwarded to the CMS as x-preview-secret.",
	},
	// Shared secret Payload's cache-invalidation hook (notifyWebCache.ts) sends in the
	// x-cms-revalidate-secret header of POST /api/cms/invalidate requests. Must match Payload's
	// own CMS_REVALIDATE_SECRET; used to authenticate that writes/deletes to the pages or updates
	// collections actually came from Payload, not a third party.
	CMS_REVALIDATE_SECRET: {
		secret: true,
		desc: "Shared secret the CMS sends in the x-cms-revalidate-secret header when it asks the app to drop cached pages. Must match the CMS's own CMS_REVALIDATE_SECRET.",
	},
	COMPARE_PANEL: {
		desc: "Comma-separated second-opinion models, in fan-out order. Off a Vercel deployment only; on Vercel, config/inference.ts decides.",
	},
	// Unset turns off the "Get involved" per-IP daily cap, the DB-backed target-email
	// OTP/invite caps and the (ip, target) source-pair cap. Three anti-abuse controls going dark on one
	// missing var is why this is warn:true rather than a bare secret entry. (CUR-920)
	CONTRIBUTION_IP_PEPPER: {
		secret: true,
		warn: true,
		desc: "Secret used to hash IP addresses for the \"Get involved\" form. Unset turns off its per-IP daily cap, its per-address code and invite caps and its source-pair cap.",
	},
	COOKIE_NAME: {
		desc: "Name of the session cookie. Default \"hf-chat\".",
	},
	COOKIE_SAMESITE: {
		desc: "SameSite attribute for the session cookie.",
	},
	COOKIE_SECURE: {
		desc: "\"true\" or \"false\" to force the Secure attribute on the session cookie.",
	},
	COOP_API_KEY: {
		secret: true,
		warn: true,
		desc: "Key for the Coop moderation service. Unset together with COOP_URL, content and child-safety moderation allow everything; only a partial Coop config logs a warning of its own.",
	},
	COOP_BLOCK_ACTIONS: {
		desc: "Comma-separated Coop actions that block a message. Default \"chat-block,chat-block-child\".",
	},
	COOP_BLOCK_ACTION_PREFIX: {
		desc: "Action-name prefix Coop uses for blocks.",
	},
	COOP_CHILD_BLOCK_ACTIONS: {
		desc: "Coop actions that mean a child-safety block. Default \"chat-block-child\".",
	},
	COOP_CHILD_BLOCK_ACTION_PREFIX: {
		desc: "Action-name prefix for child-safety blocks. Default \"chat-block-child\".",
	},
	COOP_DASHBOARD_URL: {
		desc: "Link to the Coop dashboard, shown on the admin safety page.",
	},
	COOP_ITEM_TYPE: {
		desc: "Coop item type name for chat messages. Default \"ChatMessage\".",
	},
	COOP_ITEM_TYPE_ID: {
		desc: "Coop item type id for chat messages.",
	},
	COOP_REDACT_ACTIONS: {
		desc: "Coop actions shown as a notice instead of a block. Default empty.",
	},
	COOP_SURFACE_RULE_LABEL: {
		desc: "\"false\" hides the moderation rule's label from the user.",
	},
	// The Coop User item id a Shieldstral detection hit is reported AS (the system reporter). Config,
	// not a toggle — unset means reportHitToCoop skips loudly (hits not forwarded for review).
	COOP_SYSTEM_REPORTER_ID: {
		desc: "Coop user item id that input-guard hits are reported as. Unset, hits are not forwarded to Coop for review and each skip is logged.",
	},
	COOP_TEST_OVERRIDE_ENABLED: {
		desc: "Test only: \"true\" enables a deterministic content-policy block for exercising the output-screening path. Refused in production; it never simulates a child-safety block and never sends a report to Coop.",
	},
	COOP_TIMEOUT_MS: {
		desc: "Timeout for one Coop call, in ms. Default 8000.",
	},
	COOP_URL: {
		warn: true,
		desc: "Base URL of the Coop moderation service. Unset together with COOP_API_KEY, moderation allows everything.",
	},
	COOP_USER_TYPE_ID: {
		desc: "Coop user type id.",
	},
	COOP_WARM_PATH: {
		desc: "Path the warm-up job requests to keep the Coop connection open. Default \"/health\".",
	},
	COUPLE_SESSION_WITH_COOKIE_NAME: {
		desc: "Ties the session to another cookie, as in upstream chat-ui.",
	},
	// Vercel cron auth for /chat/api/cleanup (nightly TTL GC). The route refuses when this is unset in
	// prod (an unauthenticated row-deleting endpoint is an abuse vector), so unset means the cleanup
	// cron gets a 401 every night and TTL garbage collection never runs. `warn` so boot says so.
	CRON_SECRET: {
		warn: true,
		secret: true,
		desc: "Bearer token the scheduled cleanup and warm-up jobs present. In production the cleanup route refuses every call while it is unset, so expired rows are never deleted.",
	},
	CUSTODIAL_MASTER_ACTIVE: {
		desc: "Which key id in CUSTODIAL_MASTER_IDENTITIES or CUSTODIAL_MASTER_KMS_KEYS new stored files are encrypted to; /chat/healthcheck reports it as x-custodial-master-kid.",
	},
	CUSTODIAL_MASTER_IDENTITIES: {
		secret: true,
		desc: "JSON map of key id to age identity ({\"<kid>\": \"AGE-SECRET-KEY-PQ-1...\"}) that opens owners' keys in custodial storage. One per deployment, never shared between preview and production. Unset, sealed files cannot be opened; plaintext files still read.",
	},
	CUSTODIAL_MASTER_KMS_KEYS: {
		desc: "JSON map of key id to AWS KMS key ARN ({\"<kid>\": \"arn:aws:kms:...\"}), used in place of CUSTODIAL_MASTER_IDENTITIES so the deployment holds no key that opens files. Key ids share one namespace with the age identities.",
	},
	CUSTODIAL_KMS_ROLE_ARN: {
		desc: "AWS role a Vercel deployment assumes with its own OIDC token to call CUSTODIAL_MASTER_KMS_KEYS, so no AWS secret sits in env. Unset, the AWS SDK's default credential chain applies.",
	},
	CUSTODIAL_SEAL_WRITES: {
		desc: "\"true\" encrypts every file written to custodial storage to its owner's key. Needs CUSTODIAL_MASTER_ACTIVE; without it every write fails. Turning it off leaves sealed files readable.",
	},
	DATABASE_URL: {
		req: true,
		secret: true,
		desc: "Postgres connection string; falls back to POSTGRES_URL. Locally: postgres://postgres:postgres@localhost:5432/aipotluck_test (pnpm db:start). Preview and production are separate databases.",
	},
	DEPLOY_ENV: {
		warn: true,
		desc: "Which environment this deployment is: production, preview or development. Falls back to VERCEL_ENV. Feature flags and model lists depend on it: on a host without VERCEL_ENV, leaving it unset makes every environment-scoped flag evaluate off.",
	},
	INSTANCE: {
		desc: "Name of this production instance, when one codebase serves several sites (for example an event site). Unset is the main site. Sets the session cookie name, passkey RP ID and the instance property on flag evaluations. Must be a lowercase label; anything else fails boot.",
	},
	APP_SURFACE: {
		desc: "Which app this build serves, read at build time. Unset or \"site\": the site at / and chat under /chat. \"chat\": chat at the root of its host, with the reserved /chat paths served in place. Any other value fails the build.",
	},
	FUNCTION_REGION: {
		desc: "Vercel function regions, comma-separated (for example fra1), read at build time. Unset, Vercel's default (iad1). Put functions in the same region as DATABASE_URL.",
	},
	MISTRAL_MODELS: {
		desc: "Comma-separated Mistral model ids served by MISTRAL_BASE_URL, added to the catalog before MODEL_ALLOWLIST applies. Each has only its own host as a lane, with no backup.",
	},
	MISTRAL_API_KEY: {
		secret: true,
		desc: "Key for MISTRAL_BASE_URL. Set MISTRAL_API_KEY, MISTRAL_BASE_URL and MISTRAL_MODELS together; a partial set registers nothing and logs an error.",
	},
	MISTRAL_API_KEY_CI: {
		secret: true,
		desc: "A second Mistral key. Set, preview builds of feature branches call MISTRAL_BASE_URL with it directly; unset, they use the MISTRAL_CHAT_* lane like develop.",
	},
	MISTRAL_BASE_URL: {
		desc: "OpenAI-compatible base URL for Mistral models, for example https://api.mistral.ai/v1.",
	},
	MISTRAL_CHAT_BASE_URL: {
		desc: "Alternative host for chat's Mistral models. Read only with MISTRAL_CHAT_API_KEY set, and then replaces MISTRAL_BASE_URL for chat; Mistral web search stays on MISTRAL_BASE_URL.",
	},
	MISTRAL_CHAT_API_KEY: {
		secret: true,
		desc: "Key for MISTRAL_CHAT_BASE_URL.",
	},
	MISTRAL_CHAT_MODEL_MAP: {
		desc: "Comma-separated ours=theirs pairs for MISTRAL_MODELS ids that MISTRAL_CHAT_BASE_URL names differently, for example mistral-large-2512=mistralai/mistral-large-2512.",
	},
	E2E_FAULT_INJECT_TOKEN: {
		secret: true,
		desc: "Test only: shared secret that lets end-to-end tests simulate upstream faults, checked against the x-e2e-fault-inject-token header on preview and development only. Never set in production.",
	},
	E2E_LINKED_BUCKET_TOKEN: {
		secret: true,
		desc: "CI only: write token for the test storage bucket the storage-locations spec uses. The app does not read it.",
	},
	E2E_OTP_BYPASS_TOKEN: {
		secret: true,
		desc: "Test only: shared secret that lets end-to-end tests skip the sign-in code send limit for @example.org addresses on preview and development, and authorizes flag-override cookies on hosted previews. Never set in production.",
	},
	REPLAY_DATABASE_URL: {
		secret: true,
		desc: "Test only: Postgres URL of the database of recorded model replies that preview scenario runs replay. Read only for requests carrying the fault-inject token. Never set in production. Unset on preview, a replayed turn logs the misconfiguration and runs live.",
	},
	ENABLE_ASSISTANTS: {
		desc: "\"true\" turns on chat-ui's assistants feature.",
	},
	ENABLE_CONFIG_MANAGER: {
		desc: "\"true\" lets admins override configuration at run time.",
	},
	ENABLE_DATA_EXPORT: {
		desc: "Not read. A feature flag decides whether data export is on.",
	},
	ENV_EXTRACT_SECRET: {
		secret: true,
		desc: "Bearer secret for GET /chat/admin/env-extract, the encrypted configuration export. Leave unset; the route refuses every call without it. At least 32 characters when set. Arming or disarming it needs a redeploy.",
	},
	EXPOSE_API: {
		desc: "Deprecated upstream chat-ui setting. Setting it only logs a deprecation warning.",
	},
	FALLBACK_BASE_URL: {
		desc: "Host for the backup lane. Unset, the backup lane uses HF_BASE_URL with HF_TOKEN and HF_BILL_TO.",
	},
	FALLBACK_API_KEY: {
		secret: true,
		desc: "Key for FALLBACK_BASE_URL. Unset, OPENAI_API_KEY is used. Ignored while FALLBACK_BASE_URL is unset.",
	},
	FALLBACK_MODEL_ID: {
		desc: "The backup host's spelling of the primary model id, if it cases it differently. Never a different model: a lane that asks for one is dropped. Off a Vercel deployment only; on Vercel, config/inference.ts decides.",
	},
	FIRECRAWL_API_KEY: {
		secret: true,
		warn: true,
		desc: "Firecrawl key for general web search. Unset, only the arXiv, Wikipedia and OpenAlex engines answer, and a searched turn still looks cited while missing the open web.",
	},
	FIRECRAWL_TBS: {
		desc: "Time filter applied to every Firecrawl search.",
	},
	// Folkways adapter (src/routes/folkways-adapter) — community behavior control plane. Read only
	// by that route; unset → localhost dev defaults (see the adapter's README).
	// Real upstream catalog the /models proxy forwards to when the adapter is OPENAI_BASE_URL.
	FOLKWAYS_CATALOG_BASE_URL: {
		desc: "Base URL of the model catalog the folkways adapter's /models route forwards to.",
	},
	FOLKWAYS_CATALOG_API_KEY: {
		secret: true,
		desc: "Key for the folkways adapter's model catalog. Falls back to OPENAI_API_KEY, then HF_TOKEN.",
	},
	FOLKWAYS_COMMUNITY: {
		desc: "Community name the folkways adapter reports.",
	},
	FOLKWAYS_DEPLOYMENT: {
		desc: "Deployment name the folkways adapter reports.",
	},
	// Gates every adapter route, read at request time. Unset or "0" → the routes 404. "1" → live.
	FOLKWAYS_ENABLED: {
		desc: "Fallback switch for the folkways adapter routes, used only when the PostHog flag cannot be read. Unset or \"0\", the routes return 404.",
	},
	FOLKWAYS_ENVIRONMENT: {
		desc: "Environment name the folkways adapter reports. Default \"development\".",
	},
	// "observe" → report prompts + content-free traces, pass requests through unchanged (demo mode).
	// Anything else → the resolve/rewrite path.
	FOLKWAYS_MODE: {
		desc: "Folkways adapter mode. \"observe\" reports prompts and content-free traces and passes requests through unchanged; anything else takes the resolve and rewrite path.",
	},
	// Upstream of the adapter's Mistral route; unset -> https://api.mistral.ai/v1. (CUR-3186)
	FOLKWAYS_MISTRAL_UPSTREAM_BASE_URL: {
		desc: "Upstream for the folkways adapter's Mistral route. Default https://api.mistral.ai/v1.",
	},
	FOLKWAYS_TOKEN_GATEWAY: {
		secret: true,
		desc: "Token the folkways adapter sends to the folkways service.",
	},
	FOLKWAYS_UPSTREAM_API_KEY: {
		secret: true,
		desc: "Key for the folkways adapter's upstream. Falls back to HF_TOKEN, then OPENAI_API_KEY.",
	},
	FOLKWAYS_UPSTREAM_BASE_URL: {
		desc: "The folkways adapter's upstream. Default https://router.huggingface.co/v1.",
	},
	// HF Inference Providers bill-to org for the router lane; unset → falls back to HF_BILL_TO.
	FOLKWAYS_UPSTREAM_BILL_TO: {
		desc: "Hugging Face organisation billed for the folkways adapter's upstream calls. Falls back to HF_BILL_TO.",
	},
	FOLKWAYS_URL: {
		desc: "Base URL of the folkways service. Default http://localhost:4600.",
	},
	FUZZ_OVERRIDE_ENABLED: {
		desc: "Test only: \"true\" lets local tests and the scenario suite force feature flags with a cookie. Refused in production; a hosted preview also requires the E2E_OTP_BYPASS_TOKEN key cookie.",
	},
	GAP_MAP_DATABASE_URL: {
		warn: true,
		secret: true,
		desc: "Postgres URL of the gap map database (pooled endpoint). Unset, the map, the org and product pages, the sitemap and /api/data-freshness fail.",
	},
	GENERATION_TIMEOUT_MS: {
		desc: "Watchdog for an ordinary turn, in ms. Default 45000. Agent turns use AGENT_GENERATION_TIMEOUT_MS. Capped at 155000. Needs a redeploy to change.",
	},
	// GitHub sign-in (CUR-434/CUR-482) — same optional posture as Google below: unset
	// means GitHub is simply absent from the sign-in screen, not a failure.
	GITHUB_CLIENT_ID: {
		desc: "GitHub OAuth app client id. Set, sign-in offers GitHub; unset, GitHub is absent from the sign-in screen.",
	},
	GITHUB_CLIENT_SECRET: {
		secret: true,
		desc: "GitHub OAuth app client secret.",
	},
	GLOBAL_DAILY_REQUEST_CAP: {
		desc: "Requests per day across the site. Unset or 0, no cap.",
	},
	// Google sign-in (CUR-434/CUR-482) — optional: unset means Google is simply absent from the
	// sign-in screen rather than a failure, same posture as OPENID_CLIENT_ID/loginEnabled below.
	GROUNDCHECK_TOKEN: {
		secret: true,
		desc: "Bearer token for the groundcheck service. Set with GROUNDCHECK_URL.",
	},
	GROUNDCHECK_URL: {
		desc: "Base URL of the groundcheck service, which flags unsupported spans in answers. The groundcheck flag decides whether it is used; the flag on with this unset logs a config error and skips the check.",
	},
	GOOGLE_CLIENT_ID: {
		desc: "Google OAuth client id. Set, sign-in offers Google; unset, Google is absent from the sign-in screen.",
	},
	GOOGLE_CLIENT_SECRET: {
		secret: true,
		desc: "Google OAuth client secret.",
	},
	// openSearch.ts's relative-grounding floors (readFlag("GROUND_RELATIVE_RATIO"/"GROUND_RELATIVE_MINTOP")).
	GROUND_RELATIVE_MINTOP: {
		desc: "Minimum top relevance score for web results to ground an answer. Default 0.5.",
	},
	GROUND_RELATIVE_RATIO: {
		desc: "A result's minimum score as a fraction of the top score. Default 0.25.",
	},
	GUARD_SHADOW_URL: {
		desc: "OpenAI-compatible base URL of the input guard model, which screens every message before the model sees it and declines turns. A failed guard call fails closed and declines the turn. It also feeds the measure-only guard-shadow check. Every message's full text is sent here.",
	},
	HF_BASE_URL: {
		desc: "Hugging Face router base URL, used for the backup lane and for models pinned to one Hugging Face provider.",
	},
	HF_BILL_TO: {
		desc: "Hugging Face organisation billed for router calls.",
	},
	HF_BUCKETS_REPO: {
		desc: "Hugging Face bucket for custodial file storage, as buckets/<owner>/<name>. Unset, the production bucket named in code. Each non-production environment sets its own, paired with an HF_BUCKETS_TOKEN scoped to it. A malformed value throws on first use.",
	},
	HF_BUCKETS_TOKEN: {
		secret: true,
		desc: "Hugging Face token scoped to the one bucket HF_BUCKETS_REPO names, with no org or user permissions. Separate from HF_TOKEN; neither falls back to the other.",
	},
	HF_BUCKETS_READ_TOKEN: {
		secret: true,
		desc: "CI only: read token for the preview storage bucket, handed to the custodial-storage spec. The app does not read it.",
	},
	HF_STORAGE_OAUTH_CLIENT_ID: {
		desc: "Hugging Face OAuth app used only to connect a user's own Hugging Face storage, separate from the sign-in app so its consent can be revoked on its own. Unset with the storage-locations flag on is logged and no Connect button is shown.",
	},
	HF_STORAGE_OAUTH_CLIENT_SECRET: {
		secret: true,
		desc: "Client secret for HF_STORAGE_OAUTH_CLIENT_ID. Never falls back to OPENID_CLIENT_SECRET.",
	},
	HF_RAG_EMBEDDINGS_TOKEN: {
		secret: true,
		desc: "Hugging Face token for retrieval embeddings. Falls back to HF_TOKEN.",
	},
	HF_TOKEN: {
		secret: true,
		desc: "Hugging Face token for the backup lane, the input guard (with OPENAI_API_KEY as its fallback) and other Hugging Face calls. With the zentropi-african-routing flag on it also authenticates the CoPE-B judge, which then receives the screened text of turns detected as Amharic, Yoruba, Hausa or Kiswahili.",
	},
	LLM_ROUTER_DEFAULT_ROUTE: {
		desc: "chat-ui router: name of the default route. Default \"default\".",
	},
	LLM_ROUTER_ENABLE_MULTIMODAL: {
		desc: "chat-ui router: \"true\" sends image turns to LLM_ROUTER_MULTIMODAL_MODEL.",
	},
	LLM_ROUTER_ENABLE_TOOLS: {
		desc: "chat-ui router: \"true\" lets the router send tool turns.",
	},
	LLM_ROUTER_FALLBACK_MODEL: {
		desc: "chat-ui router: model used when a route's models all fail.",
	},
	LLM_ROUTER_MULTIMODAL_MODEL: {
		desc: "chat-ui router: model for image turns.",
	},
	LLM_ROUTER_ROUTES_PATH: {
		desc: "chat-ui router: path to the routes policy JSON file. Config, not a switch: its flag turns the router on.",
	},
	LLM_SUMMARIZATION: {
		desc: "Not read. A feature flag decides whether conversations get generated titles.",
	},
	LOCALITY_SEMANTIC_ENABLED: {
		desc: "\"true\" turns on the embedding-based locality check. Default off.",
	},
	LOCALITY_SEMANTIC_THRESHOLD: {
		desc: "Similarity threshold for the locality check.",
	},
	LOCAL_GENERATION_TIMEOUT_MS: {
		desc: "Watchdog for a turn on a user-run local model, in ms. Default 155000, the ceiling, because a cold local model can take a long time to load. Needs a redeploy to change.",
	},
	LOG_LEVEL: {
		desc: "Log level. Default \"info\".",
	},
	MAX_CONCURRENT_GENERATIONS: {
		desc: "Most turns generating at once per instance. Unset or 0, no limit.",
	},
	MCP_SERVERS: {
		desc: "JSON array of MCP servers whose tools the chat may call.",
	},
	METRICS_ENABLED: {
		desc: "\"true\" serves Prometheus metrics.",
	},
	METRICS_PORT: {
		desc: "Port for the metrics server. Default 5565.",
	},
	MOCK_OIDC_CLIENT_ID: {
		desc: "Test only: client id for a stand-in sign-in provider.",
	},
	MOCK_OIDC_CLIENT_SECRET: {
		secret: true,
		desc: "Test only: client secret for the stand-in sign-in provider.",
	},
	MOCK_OIDC_PROVIDER_URL: {
		desc: "Test only: URL of the stand-in sign-in provider the sign-in spec walks. Refused in production.",
	},
	MODELS: {
		desc: "JSON5 overrides for model metadata, as in upstream chat-ui.",
	},
	MODELS_BOOT_SNAPSHOT: {
		desc: "\"off\" stops the server from booting from the committed model snapshot.",
	},
	MODEL_ALLOWLIST: {
		desc: "Off a Vercel deployment only (local dev, CI, evals): comma-separated model ids the picker offers, the first being the default, or * for all. Default swiss-ai/apertus-v1.5-70b. On Vercel the picker comes from config/inference.ts and this is ignored.",
	},
	MULTILINGUAL_EMBEDDING_ENDPOINT_URL: {
		desc: "Dedicated endpoint for the multilingual embedding model the self-identity check uses. Unset, calls go to Hugging Face serverless, which can queue for many seconds under load.",
	},
	MULTIMODAL_ENABLED: {
		desc: "\"true\" declares that the deployment can serve images and audio. Image input also needs its feature flag.",
	},
	OLD_MODELS: {
		desc: "Kept from upstream chat-ui (retired model ids). Nothing reads it; retired ids are listed in code.",
	},
	OPENAI_API_KEY: {
		req: true,
		secret: true,
		desc: "Key for OPENAI_BASE_URL.",
	},
	OPENAI_BASE_URL: {
		req: true,
		desc: "Base URL of the OpenAI-compatible endpoint for the open models, ending in /v1. Models are listed from its /models, which is scoped to the key.",
	},
	OPENAI_MAX_RETRIES: {
		desc: "Retries the OpenAI client makes on a failed call. Unset means none.",
	},
	OPENAI_PROVIDER: {
		desc: "Provider name sent with requests to the gateway.",
	},
	OPENID_CLIENT_ID: {
		desc: "OpenID Connect client id for sign-in. Unset, that sign-in option is absent.",
	},
	OPENID_CLIENT_SECRET: {
		secret: true,
		desc: "OpenID Connect client secret.",
	},
	OPENID_CONFIG: {
		desc: "JSON5 object with the OpenID Connect settings, in place of the separate variables.",
	},
	OPENID_NAME_CLAIM: {
		desc: "Claim to read the user's display name from.",
	},
	OPENID_PROVIDER_URL: {
		desc: "OpenID Connect issuer URL.",
	},
	OPENID_RESOURCE: {
		desc: "Resource indicator sent with the OpenID Connect request.",
	},
	OPENID_SCOPES: {
		desc: "Scopes requested at sign-in.",
	},
	OPENID_TOLERANCE: {
		desc: "Clock tolerance for token checks.",
	},
	// Optional knobs for the daily sign-in code caps (db/signInCodeRate.ts). Unset -> 10 codes
	// per address per 24h, and 1000/24h site-wide to addresses with no account, a circuit breaker. (CUR-4172)
	OTP_ADDRESS_MAX_PER_DAY: {
		desc: "Sign-in codes one email address can receive per day. Default 10.",
	},
	OTP_SITE_NEW_MAX_PER_DAY: {
		desc: "Sign-in codes sent per day, across the site, to addresses with no account. Default 1000.",
	},
	OUTPUT_MODERATION: {
		desc: "\"true\", \"1\" or \"on\" turns on screening of the model's output. On a deployment, screening then fails closed if its moderation config is missing.",
	},
	OUTPUT_SCREEN_PHASE_TIMEOUT_MS: {
		desc: "Time limit for the whole output-screening phase, in ms. Default 25000. On expiry, whatever already cleared is released (or declined) instead of waiting for the generation watchdog. Separate from COOP_TIMEOUT_MS, which bounds one call.",
	},
	PANGOLIN_API_URL: {
		desc: "Pangolin Integration API base URL, server to server, for user-run local models reached through a tunnel. Local dev: http://localhost:3003 (the pangolin/ stack). Unset, managed endpoints are withheld and the misconfiguration is logged.",
	},
	PANGOLIN_DOMAIN_ID: {
		desc: "Pangolin domain new tunnels are created under. Local dev: \"domain1\".",
	},
	PANGOLIN_INTEGRATION_TOKEN: {
		secret: true,
		desc: "Pangolin Integration API key (org-scoped).",
	},
	PANGOLIN_ORG_ID: {
		desc: "Pangolin organisation every tunnel belongs to. One per deployment.",
	},
	PANGOLIN_TUNNEL_ENDPOINT: {
		desc: "Address a user's device dials to open its tunnel; distinct from PANGOLIN_API_URL outside local dev.",
	},
	PG_CONNECT_TIMEOUT: {
		desc: "Postgres connect timeout, in seconds. Default 30.",
	},
	PG_IDLE_TIMEOUT: {
		desc: "Postgres idle connection timeout, in seconds. Default 150. Keep it above the one-minute warm-up cadence, or the connection the warm-up holds open closes between runs.",
	},
	PG_POOL_MAX: {
		desc: "Maximum Postgres pool size.",
	},
	PG_PRECONNECT: {
		desc: "\"off\" stops the server from opening a database connection at boot.",
	},
	POSTHOG_CLI_API_KEY: {
		secret: true,
		desc: "PostHog personal key scoped to error_tracking:write, used at build time by scripts/upload-posthog-sourcemaps.mjs to upload client source maps. Unset, the build deletes the maps instead. The running app does not read it.",
	},
	POSTHOG_CLI_PROJECT_ID: {
		secret: true,
		desc: "PostHog project id for the source-map upload.",
	},
	POSTHOG_FLAGS_SECRET_KEY: {
		secret: true,
		desc: "PostHog project secret (phs_...) that lets the server evaluate feature flags locally; scripts/bake-flag-definitions.mjs also reads it at build time. Never a personal phx_ key. Unset, flags are evaluated remotely, which works and costs requests.",
	},
	PUBLIC_APPLE_APP_ID: {
		desc: "Apple app id for the smart app banner.",
	},
	PUBLIC_APP_ASSETS: {
		desc: "Folder under static/ for logos and favicons. Default \"chatui\".",
	},
	PUBLIC_APP_DESCRIPTION: {
		desc: "App description for page metadata.",
	},
	PUBLIC_CMS_PAYLOAD_URL: {
		req: true,
		desc: "Origin of the Payload CMS deployment. Public on purpose: every CMS read is public, and the browser resolves relative media URLs against it. Server-side page reads use it too.",
	},
	PUBLIC_COMMIT_SHA: {
		desc: "Commit shown in the app. Set at build time from git when unset.",
	},
	PUBLIC_CONFIG_CACHE_HEADERS: {
		desc: "Kept from upstream chat-ui. Nothing reads it; the public-config route sets its cache headers in code.",
	},
	PUBLIC_FEATURE_ANNOUNCEMENTS: {
		desc: "Announcements shown in the chat window.",
	},
	PUBLIC_GOOGLE_ANALYTICS_ID: {
		desc: "Google Analytics id.",
	},
	PUBLIC_LLM_ROUTER_ALIAS_ID: {
		desc: "chat-ui router: id of the router's virtual model. Default \"omni\".",
	},
	PUBLIC_LLM_ROUTER_DISPLAY_NAME: {
		desc: "chat-ui router: display name of the router's virtual model. Default \"Omni\".",
	},
	PUBLIC_LLM_ROUTER_LOGO_URL: {
		desc: "chat-ui router: logo URL for the router's virtual model.",
	},
	PUBLIC_MODEL_PAGES: {
		desc: "Kept for reference. Nothing reads it; model page links are set in code.",
	},
	PUBLIC_ORIGIN: {
		req: true,
		desc: "Origin the app is served from, for example http://localhost:5173. Sign-in builds its callback URLs and passkey RP ID from it.",
	},
	PUBLIC_PLAUSIBLE_SCRIPT_URL: {
		desc: "Plausible analytics script URL.",
	},
	PUBLIC_POSTHOG_HOST: {
		desc: "PostHog host. Default https://us.i.posthog.com.",
	},
	PUBLIC_POSTHOG_KEY: {
		desc: "PostHog project token. Public by design (write-only). Unset, analytics are off.",
	},
	PUBLIC_POSTHOG_UI_HOST: {
		desc: "PostHog app host, for links into PostHog.",
	},
	PUBLIC_SEARCH_TRIGGER: {
		desc: "How a turn is judged to need web search: heuristic, model, tool or margin. Any other value, including empty, means heuristic, with no error. scripts/verify-prod-config.mjs checks the value actually served.",
	},
	PUBLIC_SEO_TITLE_SUFFIX: {
		desc: "Suffix for page titles when the CMS page has no meta title. Default \" – AI Potluck\". Keep it in step with the CMS's own SEO_TITLE_SUFFIX.",
	},
	PUBLIC_SHARE_PREFIX: {
		desc: "Kept from upstream chat-ui. Nothing in the app reads it; scripts/updateLocalEnv.ts only lists it.",
	},
	RAG_ADMIN_CACHE_TTL_MS: {
		desc: "Cache lifetime for admin-managed retrieval documents, in ms. Default 60000.",
	},
	RAG_ADMIN_ENABLED: {
		desc: "\"true\" serves the admin-managed retrieval store. Off, documents can still be authored and previewed.",
	},
	RAG_ADMIN_MAX_CHUNKS: {
		desc: "Maximum chunks in the admin-managed retrieval store. Default 2000.",
	},
	RAG_ADMIN_MAX_CHUNKS_PER_DOC: {
		desc: "Maximum chunks per admin-managed document. Default 50.",
	},
	RAG_EMBEDDING_BASE_URL: {
		desc: "Embeddings endpoint for retrieval. Default https://router.huggingface.co/hf-inference/models.",
	},
	RAG_EMBEDDING_BILL_TO: {
		desc: "Hugging Face organisation billed for embeddings. Falls back to HF_BILL_TO.",
	},
	RAG_EMBEDDING_ENDPOINT_URL: {
		desc: "Dedicated embeddings endpoint; when set, called directly in place of RAG_EMBEDDING_BASE_URL. scripts/build-rag-index.mjs reads it too.",
	},
	RAG_EMBEDDING_MODEL: {
		desc: "Embedding model. Default sentence-transformers/all-MiniLM-L6-v2.",
	},
	RAG_ENABLED: {
		warn: true,
		desc: "\"true\" turns on all retrieval grounding, local and federated. Unset, retrieval never runs and nothing is logged.",
	},
	RAG_MIN_SCORE: {
		desc: "Minimum similarity for a retrieved chunk to count.",
	},
	RAG_RERANK_MIN_SCORE: {
		desc: "Minimum reranker score for a retrieved chunk to count. Default 0.02.",
	},
	RAG_RERANK_SKIP_COSINE_BELOW: {
		desc: "Below this similarity a turn is treated as off-topic without calling the reranker.",
	},
	RAG_RERANK_TIMEOUT_MS: {
		desc: "Reranker timeout for retrieval, in ms. Default 3000.",
	},
	RAG_ROUTER_API_KEY: {
		secret: true,
		desc: "Key for the retrieval source router's model.",
	},
	RAG_ROUTER_BASE_URL: {
		desc: "Base URL for the retrieval source router's model.",
	},
	RAG_ROUTER_CATALOG_TTL_MS: {
		desc: "Cache lifetime of the source catalog, in ms. Default 3600000.",
	},
	RAG_ROUTER_ENABLED: {
		desc: "\"true\" turns on the retrieval source router. SYFTHUB_PROMPT_ONLY turns it off regardless.",
	},
	RAG_ROUTER_HONOR_EMPTY: {
		desc: "\"true\" skips retrieval when the router picks no source.",
	},
	RAG_ROUTER_MAX_ENDPOINTS: {
		desc: "Most sources the router may pick. Default 3.",
	},
	RAG_ROUTER_MODEL: {
		desc: "Model the retrieval source router uses.",
	},
	RAG_ROUTER_PROVIDER: {
		desc: "Hugging Face provider pin for the router's model.",
	},
	RAG_ROUTER_SHADOW: {
		desc: "\"true\" runs the router without acting on its choice. SYFTHUB_PROMPT_ONLY turns it off regardless.",
	},
	RAG_ROUTER_TIMEOUT_MS: {
		desc: "Router timeout, in ms. Default 4000.",
	},
	RAG_TOP_K: {
		desc: "Chunks retrieved per turn. Default 5.",
	},
	RAG_VISION_MODEL: {
		desc: "Model that captions images for retrieval. Falls back to LLM_ROUTER_MULTIMODAL_MODEL.",
	},
	RATE_LIMIT: {
		desc: "Messages per minute per session. Default 20.",
	},
	RATE_LIMIT_IP_MULTIPLIER: {
		desc: "Per-IP limit as a multiple of RATE_LIMIT. 0 turns the per-IP limit off.",
	},
	REASONING_SUMMARY: {
		desc: "\"true\" shows a summary of the model's reasoning.",
	},
	RESEND_API_KEY: {
		secret: true,
		warn: true,
		desc: "Resend key for sign-in code emails. Unset, codes are logged instead of sent and sign-in still works.",
	},
	RERANK_BASE_URL: {
		desc: "Reranker endpoint for web search (cohere transport). Falls back to OPENAI_BASE_URL.",
	},
	RERANK_BILL_TO: {
		desc: "Hugging Face organisation billed for reranking. Falls back to HF_BILL_TO.",
	},
	RERANK_ENDPOINT_TOKEN: {
		secret: true,
		desc: "Token for RERANK_ENDPOINT_URL. Falls back to RERANK_HF_TOKEN, then HF_RAG_EMBEDDINGS_TOKEN, then HF_TOKEN.",
	},
	RERANK_ENDPOINT_URL: {
		desc: "Dedicated reranker endpoint (TEI transport); when set, used in place of the other reranker settings.",
	},
	RERANK_HF_BASE_URL: {
		desc: "Hugging Face reranker base URL. Default https://router.huggingface.co.",
	},
	RERANK_HF_TOKEN: {
		secret: true,
		desc: "Hugging Face token for reranking.",
	},
	RERANK_KIND: {
		desc: "Reranker transport: tei, cohere or hf.",
	},
	RERANK_MAX_BATCH: {
		desc: "Most results sent to the reranker at once. Default 32.",
	},
	RERANK_MODEL: {
		warn: true,
		desc: "Reranker model. Unset, web results are never checked for relevance, so every searched turn answers ungrounded after paying for the search.",
	},
	SCENARIO_FAILURES_AXIOM_TOKEN: {
		secret: true,
		desc: "CI only: Axiom token for the dataset where failing scenario tests are recorded and read back. The app does not read it.",
	},
	SAFETY_SCREEN_TOKEN: {
		secret: true,
		desc: "Bearer token the agent service presents to POST /chat/api/safety/screen. Set the same value in the agent service's config. Config, not a switch: the route returns 503 while it is unset.",
	},
	SECOND_OPINION_API_KEY: {
		secret: true,
		desc: "Key for SECOND_OPINION_BASE_URL. Only the compare lane uses it.",
	},
	SECOND_OPINION_BASE_URL: {
		desc: "Endpoint for the second-opinion panel and other side-call models.",
	},
	SECOND_OPINION_DISPLAY_NAME: {
		desc: "Display name of the first second-opinion model.",
	},
	SECOND_OPINION_MODEL: {
		desc: "First second-opinion model, also used by the retrieval entity-scope guard. Off a Vercel deployment only; on Vercel, config/inference.ts decides.",
	},
	SEMANTIC_HEDGE_ENABLED: {
		desc: "\"false\" turns off the embedding check for hedged or evasive answers on grounded turns. Default on. Without it, the regex hedge check still runs.",
	},
	SEMANTIC_HEDGE_THRESHOLD: {
		desc: "Similarity a sentence must reach to count as a hedge or denial. Default 0.4.",
	},
	SILENCE_TIMEOUT_MS: {
		desc: "How long a turn may go without a new token before it counts as stalled, in ms. Default 45000. Capped at that turn's own generation timeout. Needs a redeploy to change.",
	},
	SOVEREIGN_HOSTS: {
		warn: true,
		desc: "Comma-separated host=label pairs naming model hosts the UI may describe as sovereign.",
	},
	SYFTHUB_API_TOKEN: {
		secret: true,
		warn: true,
		desc: "SyftHub token for federated retrieval. Unset, federated retrieval is off, even with every other SYFTHUB_* set.",
	},
	SYFTHUB_BASE_URL: {
		desc: "SyftHub base URL. Default https://syfthub.openmined.org.",
	},
	SYFTHUB_CATALOG_PREGATE: {
		desc: "\"off\" turns off the relevance check before SyftHub sources are queried.",
	},
	SYFTHUB_DISCOVERY_CACHE_TTL_MS: {
		desc: "Cache lifetime of SyftHub source discovery, in ms. Default 300000.",
	},
	SYFTHUB_DISCOVERY_MIN_SCORE: {
		desc: "Minimum discovery score for a SyftHub source. Default 0.4.",
	},
	SYFTHUB_DISCOVERY_TOP_K: {
		desc: "SyftHub sources considered per turn. Default 5.",
	},
	SYFTHUB_DISCOVER_TIMEOUT_MS: {
		desc: "SyftHub discovery timeout, in ms. Default 3000.",
	},
	SYFTHUB_GUEST_MODE: {
		desc: "\"true\" queries only SyftHub sources that need no payment.",
	},
	SYFTHUB_PICK_GATE_FAILCLOSED: {
		desc: "Whether the SyftHub source pick fails closed when its check cannot run.",
	},
	SYFTHUB_PICK_MIN_RERANK: {
		desc: "Minimum reranker score for a picked SyftHub source. Default 0.01.",
	},
	SYFTHUB_PROMPT_ONLY: {
		desc: "Limits SyftHub to its prompt-restricted mode and turns off the retrieval source router and warm catalog.",
	},
	SYFTHUB_PROMPT_ROUTING: {
		desc: "Turns on SyftHub's prompt-restricted routing.",
	},
	SYFTHUB_RETRIEVE_TIMEOUT_MS: {
		desc: "SyftHub retrieval timeout, in ms. Default 9000.",
	},
	SYFTHUB_RETRIEVE_TOP_K: {
		desc: "Chunks retrieved from each SyftHub source. Default 5.",
	},
	SYFTHUB_ROUTER_AUTOPICK_SCORE: {
		desc: "Score above which the router picks a SyftHub source without asking the model. Default 0.9.",
	},
	SYFTHUB_ROUTER_SEMCACHE: {
		desc: "\"off\" turns off the router's semantic cache. Default on.",
	},
	SYFTHUB_ROUTER_SEMCACHE_MIN: {
		desc: "Similarity for a semantic cache hit. Default 0.95.",
	},
	SYFTHUB_SIMILARITY_THRESHOLD: {
		desc: "Minimum similarity for a SyftHub chunk. Default 0.5.",
	},
	SYFTHUB_SOURCE_BLOCKLIST: {
		desc: "SyftHub sources never to query.",
	},
	SYFTHUB_SOURCE_OWNER: {
		desc: "Limits SyftHub sources to one owner.",
	},
	SYFTHUB_SOURCE_TAG: {
		desc: "Limits SyftHub sources to one tag.",
	},
	TASK_MODEL: {
		desc: "Model for side calls such as titles, the search classifier and groundcheck. Off a Vercel deployment only; on Vercel, config/inference.ts decides.",
	},
	THIRD_OPINION_DISPLAY_NAME: {
		desc: "Display name of the second second-opinion model.",
	},
	THIRD_OPINION_MODEL: {
		desc: "Second second-opinion model. Off a Vercel deployment only; on Vercel, config/inference.ts decides.",
	},
	TRANSCRIPTION_BASE_URL: {
		desc: "Speech-to-text endpoint. Default https://router.huggingface.co/hf-inference/models.",
	},
	TRANSCRIPTION_MODEL: {
		desc: "Speech-to-text model for dictation. Dictation also needs its feature flag.",
	},
	TRIG_LINEAR_API_KEY: {
		secret: true,
		desc: "CI only: Linear key for the scheduled ticket workflows (trig-sweep.yml and others). The app does not read it.",
	},
	TRIG_POSTHOG_API_KEY: {
		secret: true,
		desc: "CI only: PostHog key for the scheduled flag workflows. The app does not read it.",
	},
	TRIG_POSTHOG_HOST: {
		desc: "CI only: PostHog host for the scheduled flag workflows. The app does not read it.",
	},
	TRIG_POSTHOG_PROJECT_ID: {
		desc: "CI only: PostHog project for the scheduled flag workflows. The app does not read it.",
	},
	USAGE_LIMITS: {
		desc: "JSON5 object of per-user limits, such as conversations and message length.",
	},
	USE_USER_TOKEN: {
		secret: true,
		desc: "\"true\" sends each user's own Hugging Face token instead of the server's.",
	},
	REPORT_SLACK_WEBHOOK: {
		secret: true,
		desc: "Webhook that receives a link to each answer report when the report-fanout flag is on. It carries the reason and an admin link, never the answer text. Unset with the flag on, a warning is logged.",
	},
	REPORT_LINEAR_API_KEY: {
		secret: true,
		desc: "Linear API key that user answer reports open issues with, when the report-fanout flag is on. Needs REPORT_LINEAR_TEAM_ID. Separate from the CI-only TRIG_LINEAR_API_KEY.",
	},
	REPORT_LINEAR_TEAM_ID: {
		desc: "Linear team id (UUID) that answer-report issues are filed under. Not a credential.",
	},
	SLACK_ALERT_WEBHOOK: {
		secret: true,
		desc: "Webhook that receives operational alerts. Anyone with the URL can post to the channel, so keep it server-only. Unset, alerts are logged but not delivered.",
	},
	VERCEL_AUTOMATION_BYPASS_SECRET: {
		secret: true,
		desc: "Vercel's deployment-protection bypass token, so the every-minute warm-up job (and scripts/warm-cache.mjs) can reach a protected deployment. Ours despite the VERCEL_ prefix: config/platform-noise.mjs exempts it.",
	},
	WARM_THROTTLE_MS: {
		desc: "Test only: overrides every warm-up check's throttle window. Leave unset in every deployment; a large value suppresses health checks. A non-numeric or non-positive value is ignored.",
	},
	// Optional deploy knob for the per-inviting-user workspace-invite counter
	// (db/workspaceInviteRate.ts). Unset -> 20/24h, the default is correct with no committed
	// .env entry. (CUR-912)
	WORKSPACE_INVITE_MAX_PER_DAY: {
		desc: "Workspace invites one account can send per day. Default 20.",
	},
	// Optional knob for an account under a week old (db/workspaceInviteRate.ts). Unset -> 5/24h,
	// capped at WORKSPACE_INVITE_MAX_PER_DAY, so a few fresh accounts can't spend the site-wide ceiling. (CUR-4168)
	WORKSPACE_INVITE_NEW_ACCOUNT_MAX_PER_DAY: {
		desc: "Workspace invites an account under a week old can send per day. Default 5, capped at WORKSPACE_INVITE_MAX_PER_DAY.",
	},
	// Optional knob for the site-wide workspace-invite ceiling (db/workspaceInviteRate.ts).
	// Unset -> 500/24h, a circuit breaker well above real use (CUR-4172). (CUR-3194)
	WORKSPACE_INVITE_SITE_MAX_PER_DAY: {
		desc: "Workspace invites per day across the site. Default 500.",
	},
	WORLD_MODEL_PREPASS: {
		desc: "\"true\" turns on an experimental world-model verification pass before answering. Default off.",
	},
};

const KEYS = Object.keys(ENV_MANIFEST).sort();
export const allKeys = () => KEYS.slice();
export const requiredKeys = () => KEYS.filter((k) => ENV_MANIFEST[k].req);
export const warnKeys = () => KEYS.filter((k) => ENV_MANIFEST[k].warn);
export const isSecret = (k) =>
	!!ENV_MANIFEST[k]?.secret ||
	/(PASSWORD|SECRET|TOKEN|_KEY$|API_KEY|PEPPER|CREDENTIAL|PRIVATE)/i.test(k);
export const isPublic = (k) => k.startsWith("PUBLIC_");
