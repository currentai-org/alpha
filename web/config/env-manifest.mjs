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
//   bootReq: narrows WHERE a `req` key is fatal at server boot; the deploy gate and .env.example still
//            read `req` alone. Unset means every boot. "site-deployment" means only a build of the site
//            surface (APP_SURFACE unset or `site`) running as a declared production or preview
//            deployment. "production" means any build, on any surface, whose declared
//            environment is production. See bootRequiredKeys below.
//   site:   the site itself reads it (CMS pages, the gap map, links). A `site-only` build (www once chat
//            lives on alpha) boots on these alone: its boot checks no key without `site`, so
//            chat's keys can leave that deployment's env.
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
//                       HIT-ONLY: Coop receives a /report when the screen above flags
//                       something, NOT every turn — guardGate.ts:7, moderation.ts:216.)
// The primary leg's endpoint and key differ between deployments, so read the live value rather than
//   trusting a note (including this one). Every lane is served by the LiteLLM
//   gateway, with dev and prod on separate credentials. MODEL_ALLOWLIST names
//   Apertus 1.5, and every eval, spec and turn resolves the same id from it.
//   ⚠️ A direct CSCS lane and the gateway CASE their model ids differently — CSCS
//      `apertus-ai/Apertus-v1.5-70B`, gateway `swiss-ai/apertus-v1.5-70b` — and selectAllowedModels
//      matches ids EXACTLY (modelsCatalog.ts:29). A retyped id matches nothing, buildModels() throws,
//      and the deployment is hard-down. Copy ids from a live /v1/models response, never
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
	ADMIN_CLI_LOGIN: {},
	ADMIN_TOKEN: { secret: true },
	// brute-force lockout for the admin CLI-token check (validate-token/+server.ts, adminTokenRate.ts) —
	// unset -> the sized default is correct.
	ADMIN_TOKEN_MAX_FAILS: {},
	ADMIN_TOKEN_WINDOW_MIN: {},
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
		desc: "\"true\" allows the app to be embedded in an iframe on other sites. Read at build time by sveltekit.config.js.",
	},
	ALLOW_INSECURE_COOKIES: {
		desc: "\"true\" sends session cookies without the Secure attribute. For local HTTP only.",
	},
	ALPHA_EDITION: {
		req: true,
		bootReq: "production",
		desc: "Production must set it to \"hosted\": a production deployment without it refuses to boot, because a process with no PUBLIC_POSTHOG_KEY would otherwise read each flag's self-host default. \"hosted\" keeps those defaults off in a process that has no PUBLIC_POSTHOG_KEY on purpose (the unit suites). A self-host sets \"selfhost\": the self-host compose stack does, and it is what lets a self-host in production mode run without Coop (moderation.ts), keep its own MODEL_ALLOWLIST and role models (committedConfigEnv in config/inference.ts), honour CSAM_SCAN=off, and skip our status page and Hugging Face's embedder. A preview or local process leaves it unset, and then a process with no PUBLIC_POSTHOG_KEY reads each flag's self-host default.",
	},
	ALPHA_FLAGS: {
		desc: "Self-hosted only (read when PUBLIC_POSTHOG_KEY is unset). Comma-separated flag overrides: \"+key\" turns a flag on, \"-key\" turns it off, on top of each key's self-host default in flagKeys.ts. Ignored when PostHog is configured.",
	},
	ALPHA_MODELS_FILE: {
		desc: "Self-hosting: path to a JSON model list in config/inference.ts's schema (providers, model_list, roles). When set it decides OPENAI_BASE_URL, OPENAI_API_KEY, MODEL_ALLOWLIST and the role models, and a bad file stops the boot with its path in the error. Read only on a self-host edition.",
	},
	ALPHA_OPEN_SIGNUP: {
		desc: "Self-host with no mailer only. Unset, the first email-and-password account succeeds and password sign-up closes after it, as Open WebUI does; \"true\" keeps sign-up open to anyone who reaches the stack. A hosted deployment, or a self-host with a mailer, ignores it.",
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
	AUTO_LARGE_TASK_MODEL: {
		desc: "Self-host: a served model id where Auto sends a turn it grades as a large task, such as a frontier model listed in OPENAI_API_BASE_URLS. It applies only when Auto has no catalogued model to rank; unset, every turn stays on the default model. A name no endpoint serves is logged as an error and ignored.",
	},
	// Better Auth's session/cookie signing key. Not req:true: that would hard-crash local dev
	// boot for anyone without it in their local env. warn:true instead, because the
	// better-auth-signin flag gates only the /chat/login redirect, not the /chat/api/auth/* routes,
	// which are always mounted and reachable directly. An unset or rotated value in prd/preview must
	// be loud, not silent.
	BETTER_AUTH_SECRET: {
		secret: true,
		warn: true,
		desc: "Signing secret for sessions. Set it in every shared environment: the auth routes are mounted whatever the sign-in flag says, and a missing or rotated value signs everyone out.",
	},
	// External dead-man's switch for the warm cron. Better Stack alerts when pings STOP, so
	// this is the check-on-the-checker that survives us being down. PROD ONLY — sharing one heartbeat
	// with preview would let preview hold it green while prod is dead.
	BETTERSTACK_HEARTBEAT_URL: {
		secret: true,
		desc: "Uptime heartbeat URL pinged by the warm-up job, so an outside monitor alerts when the pings stop. Production only: a preview sharing it could keep it green while production is down.",
	},
	// Per-dependency heartbeats behind the PUBLIC status page's four capability components.
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
		desc: "Base URL of the optional known-CSAM hash check run on every chat and My files picture, answered by the provider CSAM_SCAN_PROVIDER names. Unset (with CSAM_SCAN_PROVIDER unset too), no hash check runs: uploads are taken and each picture logs one line saying so. Set, the check fails closed: if it cannot be reached the file is refused and the turn's text is still answered, and a match refuses the upload, alerts and reports to Coop.",
	},
	CSAM_SCAN_PROVIDER: {
		desc: "Which hash-matching provider answers at CSAM_SCAN_BASE_URL (storage/csamScan.ts). Defaults to \"hma\", a self-run HMA instance. A name no provider answers to, or a provider with no CSAM_SCAN_BASE_URL, refuses every upload.",
	},
	BRAND_ORGANISATION_NAME: {
		desc: "Who runs this install, as the chat and the model name them (\"a chat app that <name> runs\"). Unset or blank: \"Current AI\". Read at runtime, so a self-host renames a prebuilt image without rebuilding it.",
	},
	BRAND_PRODUCT_NAME: {
		desc: "The app's name in the chat header, the sidebar, the page title, the sign-in email and what the model says it answers inside. Unset or blank: WEBUI_NAME if set, else \"AI Potluck\".",
	},
	BRAND_ASSISTANT_NAME: {
		desc: "A name the assistant answers to on this install; it still names the model it runs on. Unset or blank: it answers with its model's name.",
	},
	WEBUI_NAME: {
		desc: "Open WebUI's name for the app, read as BRAND_PRODUCT_NAME when that is unset, so an install moving from Open WebUI keeps its name.",
	},
	CSAM_SCAN: {
		desc: "Self-host only. \"off\" records that the operator chose to run no CSAM hash check and owns detecting and reporting CSAM: uploads are stored unscanned (each picture logs a line), and it stands in for the scanner keys in the self-host flag defaults. Honoured only when ALPHA_EDITION is set and is not \"hosted\"; a hosted deployment ignores it and logs an error once.",
	},
	CSAM_SCAN_TOKEN: {
		secret: true,
		desc: "Bearer token for the proxy in front of the hash check, when it needs one. A wrong or missing token looks the same as a scanner that cannot be reached, so uploads are refused.",
	},
	CHALLENGE_REDERIVE_ENABLED: {
		desc: "\"true\" makes the model re-derive an answer the user challenges instead of conceding. Default off.",
	},
	CI_LINEAR_CLIENT_ID: {
		secret: true,
		desc: "CI only: client id of the issue-tracker app that CI jobs mint a short-lived token from. Without it they fall back to TRIG_LINEAR_API_KEY. The app does not read it.",
	},
	CI_LINEAR_CLIENT_SECRET: {
		secret: true,
		desc: "CI only: client secret paired with CI_LINEAR_CLIENT_ID. The app does not read it.",
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
	CDN_CACHE_TAG_HEADER: {
		desc: "Self-hosting behind your own CDN: the tag header it purges by (cache-tag, surrogate-key or edge-cache-tag). CMS pages then carry it beside Vercel-Cache-Tag (CUR-4834). Unset on Vercel.",
	},
	CDN_PURGE_TOKEN: {
		secret: true,
		desc: "Bearer token sent with the CDN_PURGE_URL request, if your CDN wants one (CUR-4834).",
	},
	CDN_PURGE_URL: {
		desc: 'Self-hosting behind your own CDN: an https endpoint a CMS publish POSTs {"tags":["cms-page"]} to, the shape Cloudflare purge-by-tag takes (CUR-4834). Unset on Vercel, which purges its own edge.',
	},
	COMPARE_PANEL: {
		desc: "Comma-separated second-opinion models, in fan-out order. Off a Vercel deployment only; on Vercel, config/inference.ts decides.",
	},
	// Unset turns off the "Get involved" per-IP daily cap, the DB-backed target-email
	// OTP/invite caps and the (ip, target) source-pair cap. Three anti-abuse controls going dark on one
	// missing var is why this is warn:true rather than a bare secret entry.
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
	// Scheduler auth for /chat/api/cleanup (nightly TTL GC) and /chat/api/probes (the every-minute probes
	// job). Both refuse when this is unset outside `vite dev`, so unset means the cleanup never runs, the
	// probes never alert, and the uptime heartbeat goes quiet. `warn` so boot says so.
	CRON_SECRET: {
		warn: true,
		secret: true,
		desc: "Bearer token the scheduled cleanup and probes jobs present. Outside local dev both routes refuse every call while it is unset, so expired rows are never deleted and the probes never alert.",
	},
	CUSTODIAL_MASTER_ACTIVE: {
		desc: "Which key id in CUSTODIAL_MASTER_IDENTITIES or CUSTODIAL_MASTER_KMS_KEYS new stored files are encrypted to; /chat/healthcheck reports it as x-custodial-master-kid to a request carrying the CRON_SECRET bearer.",
	},
	CUSTODIAL_MASTER_IDENTITIES: {
		secret: true,
		desc: "JSON map of key id to age identity ({\"<kid>\": \"AGE-SECRET-KEY-PQ-1...\"}) that opens owners' keys in custodial storage. One per deployment, never shared between preview and production. Unset, sealed files cannot be opened; plaintext files still read.",
	},
	CUSTODIAL_MASTER_KMS_KEYS: {
		desc: "JSON map of key id to AWS KMS key ARN ({\"<kid>\": \"arn:aws:kms:...\"}), used in place of CUSTODIAL_MASTER_IDENTITIES so the deployment holds no key that opens files. Key ids share one namespace with the age identities, and CUSTODIAL_MASTER_ACTIVE may name either. Credentials come from CUSTODIAL_KMS_ROLE_ARN on Vercel, else the AWS SDK's default chain (task role, AWS_ROLE_ARN web identity, AWS_PROFILE, or AWS_ACCESS_KEY_ID).",
	},
	CUSTODIAL_KMS_ROLE_ARN: {
		desc: "AWS role a Vercel deployment assumes with its own OIDC token to call CUSTODIAL_MASTER_KMS_KEYS, so no AWS secret sits in env. Read on Vercel only: unset there, or on any other host whatever its value, credentials come from the AWS SDK's default chain.",
	},
	CUSTODIAL_SEAL_WRITES: {
		desc: "\"true\" encrypts every file written to custodial storage to its owner's key. Needs CUSTODIAL_MASTER_ACTIVE; without it every write fails. Turning it off leaves sealed files readable.",
	},
	CONVERSATION_HISTORY_MAC_KEY: {
		secret: true,
		desc: "Server secret (32+ random bytes, strict hex or base64) for the HMAC-SHA-256 each sealed message carries, held as key id k0. A turn's history from the browser must match it, so a forged earlier message is refused. A value that is not strict hex or base64 is rejected and logged. To rotate, add the new key to CONVERSATION_HISTORY_MAC_KEYS and name it in CONVERSATION_HISTORY_MAC_KEY_ACTIVE, keeping this one until no MAC on k0 is left.",
	},
	CONVERSATION_HISTORY_MAC_KEYS: {
		secret: true,
		desc: "JSON map of key id to history MAC key ({\"<kid>\": \"<hex or base64>\"}) for rotation (CUR-4983). Every listed key checks a MAC that names it; a turn that passes re-takes its MACs under the active key, so an old key can be dropped once its chats have been used. A k0 here replaces CONVERSATION_HISTORY_MAC_KEY.",
	},
	CONVERSATION_HISTORY_MAC_KEY_ACTIVE: {
		desc: "The key id new history MACs are taken under. Unset: the only key, or k0 when there are several. A kid with no key stops sealing writes, which fail rather than land in plaintext.",
	},
	CUSTODIAL_STORAGE_BACKEND: {
		desc: "Self-hosting: where people's files are kept (CUR-4872). Required: unset is a configuration error and storage stays unavailable. hf is the Hugging Face bucket in HF_BUCKETS_REPO; s3 is any S3-compatible bucket (CUSTODIAL_S3_*); local is a directory on the server (CUSTODIAL_LOCAL_DIR). Files are stored as written unless CUSTODIAL_SEAL_WRITES=true, which seals each to its owner before any backend sees it. Any other value leaves storage unavailable and logs why.",
	},
	CUSTODIAL_S3_BUCKET: {
		desc: "The bucket CUSTODIAL_STORAGE_BACKEND=s3 stores into. Credentials come from the AWS SDK's default chain (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, AWS_PROFILE, a task or instance role), so none is named here (CUR-4835).",
	},
	CUSTODIAL_S3_ENDPOINT: {
		desc: "The S3-compatible server's URL (MinIO, Garage, Ceph, R2...). Unset → AWS S3 in CUSTODIAL_S3_REGION.",
	},
	CUSTODIAL_S3_REGION: {
		desc: "The S3 region. Unset → the AWS SDK's own (AWS_REGION). Most S3-compatible servers accept any value, such as us-east-1.",
	},
	CUSTODIAL_S3_FORCE_PATH_STYLE: {
		desc: "\"true\" addresses the bucket by path (endpoint/bucket/key) rather than by host. Defaults on when CUSTODIAL_S3_ENDPOINT is set (MinIO and most S3-compatible servers need it); \"false\" turns it off there.",
	},
	CUSTODIAL_LOCAL_DIR: {
		desc: "The absolute directory CUSTODIAL_STORAGE_BACKEND=local keeps files in. Back it up with the database: it holds every person's sealed files and their key objects.",
	},
	DAILY_CLEANUP_FIRST_RUN_DELAY_MS: {
		desc: "Off Vercel only: a fixed delay in ms before the in-process daily cleanup's first run (dailyCleanupSchedule.ts), in place of the one-to-ten-minute jitter. For CI smokes; leave unset in production. Ignored unless a whole number of at least 1000.",
	},
	DATABASE_URL: {
		req: true,
		secret: true,
		desc: "Postgres connection string; falls back to POSTGRES_URL. Locally: postgres://postgres:postgres@localhost:5432/aipotluck_test (pnpm db:start). Preview and production are separate databases.",
	},
	DEPLOY_ENV: {
		warn: true,
		site: true,
		desc: "Which environment this deployment is: production, preview or development. Falls back to VERCEL_ENV. Feature flags and model lists depend on it: on a host without VERCEL_ENV, leaving it unset makes every environment-scoped flag evaluate off.",
	},
	// Host-neutral plan, sub-issue 1: the deployment's identity under names of our own. Each is read only
	// through src/lib/server/runtimeEnv.js, which falls back to the Vercel variable named in its desc, so
	// all five stay unset on Vercel and no env store changes until the host move sets them.
	GIT_REF: {
		desc: "The git branch this deployment was built from (runtimeEnv.js gitRef()). Unset on Vercel, which supplies VERCEL_GIT_COMMIT_REF instead and that is the fallback. Decides the Mistral key lane, the passkey RP ID on develop, the per-PR preview checks and the replay scope, so a host that serves previews must set it.",
	},
	GIT_SHA: {
		desc: "The commit this deployment was built from (runtimeEnv.js gitSha()). Unset on Vercel, which supplies VERCEL_GIT_COMMIT_SHA instead and that is the fallback. Read at build time for PUBLIC_COMMIT_SHA (sveltekit.config.js, which then asks git) and the PostHog source-map release, and at runtime for log lines and the journeys page.",
	},
	DEPLOYMENT_URL: {
		desc: "This deployment's own hostname, no scheme (runtimeEnv.js deploymentUrl()). Unset on Vercel, which supplies VERCEL_URL instead and that is the fallback. A per-PR preview's passkey RP ID is this host.",
	},
	POSTHOG_INGEST_HOST: {
		desc: "Absolute https origin of this deployment's PostHog (CUR-4833): where the /rs proxy forwards and where the server-side flag and error clients send when PUBLIC_POSTHOG_HOST is relative. Unset means https://eu.i.posthog.com, where production's project 345429 lives since it moved from US (CUR-439). PostHog Cloud's assets host is derived (eu. -> eu-assets.); a self-hosted PostHog serves both from this origin.",
	},
	POSTHOG_APP_HOST: {
		desc: "Absolute https origin of this deployment's PostHog app and management API (config/posthogRegion.mjs, CUR-439): the source-map upload's --host and the flag scripts' API reads. Unset, it follows POSTHOG_INGEST_HOST (eu.i.posthog.com -> eu.posthog.com), which unset means https://eu.posthog.com.",
	},
	POSTHOG_PROJECT_ID: {
		desc: "The PostHog project the flag scripts read through the management API (config/posthogRegion.mjs, CUR-439). Unset means 345429, the EU project. Not a credential.",
	},
	PRODUCTION_URL: {
		desc: "The project's production hostname, no scheme (runtimeEnv.js productionUrl()), read at BUILD time by vite.config.ts for the canonical origin of prerendered pages. Unset on Vercel, which supplies VERCEL_PROJECT_PRODUCTION_URL instead and that is the fallback.",
	},
	REGION: {
		desc: "The region this server runs in (runtimeEnv.js region()), shown as the app hop of a turn's serving route. Unset on Vercel, which supplies VERCEL_REGION instead and that is the fallback. Not FUNCTION_REGION, which picks the region at build time.",
	},
	INSTANCE: {
		desc: "Name of this production instance, when one codebase serves several sites (for example an event site). Unset is the main site. Sets the session cookie name, passkey RP ID and the instance property on flag evaluations. Must be a lowercase label; anything else fails boot.",
	},
	APP_SURFACE: {
		desc: "Which app this build serves, read at build time. Unset or \"site\": the site at / and chat under /chat. \"chat\": chat at the root of its host, with the reserved /chat paths served in place. Any other value fails the build.",
	},
	FUNCTION_REGION: {
		desc: "Vercel function regions, comma-separated (for example fra1), read at build time. Unset, the region beside the Neon host in DATABASE_URL (src/lib/functionRegion.js), or Vercel's default (iad1) when the URL names no mapped Neon region.",
	},
	MILA_SP_ENDPOINT_URL: {
		desc: "Base URL of the Mila suicide-prevention classifier (TEI, `POST /tokenize` and `/predict`) that the `mila-sp-output-guard` flag turns on (detectors/milaSp.ts). Optional on Current AI's deployments: with DEPLOY_ENV (or VERCEL_ENV) production or preview and this unset, the endpoint is the committed `deployed_api_base` in web/config/safetyScreen.ts. Anywhere else (local dev, CI, a self-host) it is the only address: unset means the classifier is not configured, and flag on logs an error and checks nothing, even with HF_TOKEN set. Set, it wins on every deployment.",
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
	MISTRAL_CHAT_CI_API_KEY: {
		secret: true,
		desc: "A second key for MISTRAL_CHAT_BASE_URL. Set, preview builds of feature branches call the router with it instead of MISTRAL_CHAT_API_KEY, so the router's usage shows CI's share; same Mistral account and limit.",
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
	ENTITY_SCOPE_MODEL: {
		desc: "The RAG entity-scope guard's model (CUR-4816). models.ts registers it like any side-call model: on the Mistral side-call lane when MISTRAL_MODELS lists it and side-call-own-lane is on (CUR-5024), otherwise on the compare endpoint (SECOND_OPINION_BASE_URL/API_KEY); unregistered, the guard falls back to the default endpoint and logs an error. On a Vercel deployment config.ts serves ROLE_MODELS in config/inference.ts and ignores this var (CUR-2277); it decides only off Vercel (local dev, CI, evals).",
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
	FIRECRAWL_BASE_URL: {
		desc: "Base URL of a self-hosted Firecrawl, which serves the same v2 API (Firecrawl is AGPL). Unset, search and scrape go to https://api.firecrawl.dev.",
	},
	SEARXNG_URL: {
		desc: "Base URL of a SearXNG instance with the json format enabled (selfhost/compose.yaml's searxng profile is one). Searched for the open web in Firecrawl's place, and only while FIRECRAWL_API_KEY is unset. Unset, nothing changes.",
	},
	READ_ALOUD_BASE_URL: {
		desc: "Base URL of an OpenAI-compatible speech API for read-aloud, ending in /v1; Alpha posts to <base>/audio/speech. Unset, the Hugging Face router route, which uses HF_TOKEN. With this set, read-aloud needs no Hugging Face credential.",
	},
	READ_ALOUD_API_KEY: {
		secret: true,
		desc: "Bearer key for READ_ALOUD_BASE_URL. Unset, no Authorization header is sent, for a keyless speech server. Ignored while READ_ALOUD_BASE_URL is unset.",
	},
	READ_ALOUD_MODEL: {
		desc: "Model name sent to READ_ALOUD_BASE_URL's speech server. Unset, hexgrad/Kokoro-82M. Ignored while READ_ALOUD_BASE_URL is unset.",
	},
	READ_ALOUD_VOICE: {
		desc: "Voice name sent to READ_ALOUD_BASE_URL's speech server, for every language. Unset, the Kokoro voice for the clip's language. Ignored while READ_ALOUD_BASE_URL is unset.",
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
	// Upstream of the adapter's Mistral route; unset -> https://api.mistral.ai/v1.
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
		site: true,
		secret: true,
		desc: "Postgres URL of the gap map database (pooled endpoint). Unset, the map, the org and product pages, the sitemap and /api/data-freshness fail.",
	},
	GENERATION_TIMEOUT_MS: {
		desc: "Watchdog for an ordinary turn, in ms. Default 45000. Agent turns use AGENT_GENERATION_TIMEOUT_MS. Capped at 155000. Needs a redeploy to change.",
	},
	// GitHub sign-in — same optional posture as Google below: unset
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
	// Google sign-in — optional: unset means Google is simply absent from the
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
		desc: "OpenAI-compatible base URL of the Shieldstral guard endpoint. detectors/shieldstral.ts:30 — the SYNC INPUT GATE (guardGate.ts:1, Shieldstral-1.0-3B). Every turn passes through it before reaching the model and it is what DECLINES a turn; guardPrimaryConfigured() derives entirely from this var being set. An UNKNOWN from this endpoint — non-2xx, garbled body, network error, op-deadline — fails CLOSED and labels the turn child_safety with generic child copy. So pointing this var at the wrong host does not degrade a log line; it declines real people's messages. Token and bill-to reuse HF_TOKEN||OPENAI_API_KEY and HF_BILL_TO; model + timeout are fixed constants. The name is historical: it predates the Shieldstral guard (detectors/shieldstral.ts:27). Privacy note: this endpoint receives the full text of every message, so name it in your deployment's privacy notice.",
	},
	GUEST_HANDOFF_SECRET: {
		site: true,
		secret: true,
		desc: "Key that seals a guest's session when www hands it to alpha (guestHandoffPage.ts). Set the same value on www and alpha. Unset, BETTER_AUTH_SECRET seals it, and with neither a guest arriving from www starts a new session on alpha.",
	},
	HF_BASE_URL: {
		desc: "Hugging Face router base URL, used for the backup lane and for models pinned to one Hugging Face provider.",
	},
	HF_BILL_TO: {
		desc: "Hugging Face organisation billed for router calls.",
	},
	HF_BUCKETS_REPO: {
		desc: "The custodial storage bucket, as buckets/<owner>/<name>. Unset on a production deployment (DEPLOY_ENV or VERCEL_ENV production) → production's own bucket (PRODUCTION_CUSTODIAL_BUCKET_REPO in custodialBucketRepo.ts). Unset anywhere else (preview, local dev, CI, a self-host) → custodial storage is unavailable: the surface is off whatever its flag says, one error is logged, and a direct storage call throws CustodialBucketUnsetError (storage/custodialBucketRepo.ts). Preview sets its own, paired with a HF_BUCKETS_TOKEN scoped to that bucket only, so preview never reads or writes production files. A malformed value throws on first storage call; it never falls back.",
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
	GOOGLE_CONNECT_CLIENT_ID: {
		desc: "Self-host only: the operator's own Google OAuth client (Web application type) behind Connect Google in Settings → Connectors. Its redirect URI is <PUBLIC_ORIGIN>/chat/api/connectors/google/callback. With GOOGLE_CONNECT_CLIENT_SECRET and GOOGLE_CONNECTOR_URL it turns the google-connector flag on in self-host (selfhost/README.md).",
	},
	GOOGLE_CONNECT_CLIENT_SECRET: {
		secret: true,
		desc: "Client secret for GOOGLE_CONNECT_CLIENT_ID. Stays in the web service; the Google connector never sees it.",
	},
	GOOGLE_CONNECTOR_URL: {
		desc: "Self-host only: the MCP endpoint of the Google connector the `google` compose profile runs (http://google:8000/mcp there). Each connected person's short-lived Google access token is sent to this origin and no other.",
	},
	HF_RAG_EMBEDDINGS_TOKEN: {
		secret: true,
		desc: "Hugging Face token for retrieval embeddings. Falls back to HF_TOKEN.",
	},
	HF_TOKEN: {
		secret: true,
		desc: "Hugging Face token. Among its readers: the Shieldstral guard (detectors/shieldstral.ts, with OPENAI_API_KEY as the fallback). With the `mila-sp-output-guard` flag on, the Mila suicide-prevention classifier on our own Inference Endpoint (detectors/milaSp.ts; threshold and 2 s budget in web/config/safetyScreen.ts, address in MILA_SP_ENDPOINT_URL or, on production and preview, that file) reads it too; flag on with this unset logs an error and checks nothing. Privacy note: with that flag on, the text of every finished English or French answer goes to that endpoint, never the user's own messages.",
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
	LOCAL_INFERENCE_INTERNAL_ADDRESSES: {
		desc: "\"allow\" lets the people signed in add a local inference endpoint at a private address: localhost, the LAN, RFC1918, the VPC. Set it only where everyone who can sign in may reach this host's network, such as a single-user self-host whose Ollama runs beside it. Unset, a self-host (ALPHA_EDITION=selfhost) refuses private addresses whatever DEPLOY_ENV says, and other deployments allow them only under DEPLOY_ENV=development. Cloud-metadata and container-credential addresses (169.254.0.0/16, fd00:ec2::254) are refused either way.",
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
	OAUTH_CLIENT_ID: { desc: "Open WebUI's name for OIDC_CLIENT_ID, read when that is unset (CUR-4858)." },
	OAUTH_CLIENT_SECRET: { secret: true, desc: "Open WebUI's name for OIDC_CLIENT_SECRET (CUR-4858)." },
	OAUTH_PROVIDER_NAME: { desc: "Open WebUI's name for OIDC_PROVIDER_NAME (CUR-4858)." },
	OAUTH_SCOPES: { desc: "Open WebUI's name for OIDC_SCOPES (CUR-4858)." },
	OIDC_CLIENT_ID: { desc: "Self-hosting: the client id of your organisation's OIDC login (CUR-4858)." },
	OIDC_CLIENT_SECRET: { secret: true, desc: "Self-hosting: the client secret paired with OIDC_CLIENT_ID (CUR-4858)." },
	OIDC_ISSUER: {
		desc: "Self-hosting: your organisation's OpenID Connect issuer (Keycloak, Authentik, Cognito, Entra...), https, discovered at /.well-known/openid-configuration. With OIDC_CLIENT_ID and OIDC_CLIENT_SECRET it adds a sign-in button; an unreachable issuer drops only that button (CUR-4858). OPENID_PROVIDER_URL is read in its place beside OAUTH_CLIENT_ID, as Open WebUI names it.",
	},
	OIDC_PROVIDER_NAME: { desc: "Self-hosting: the name on your organisation's sign-in button. Default SSO (CUR-4858)." },
	OIDC_SCOPES: { desc: "Self-hosting: the scopes your organisation's sign-in asks for, space-separated. Default openid email profile (CUR-4858)." },
	OLD_MODELS: {
		desc: "Kept from upstream chat-ui (retired model ids). Nothing reads it; retired ids are listed in code.",
	},
	OPENAI_API_BASE_URLS: {
		desc: "Open WebUI's name for the model endpoint: ';'-separated base URLs. Read only while OPENAI_BASE_URL is unset; Alpha serves one endpoint, so the first is used and the rest are logged as ignored. Keys pair with URLs by position in OPENAI_API_KEYS.",
	},
	OPENAI_API_KEY: {
		req: true,
		secret: true,
		desc: "Key for OPENAI_BASE_URL.",
	},
	OPENAI_API_KEYS: {
		secret: true,
		desc: "Open WebUI's name for the model endpoint's keys: ';'-separated, one per OPENAI_API_BASE_URLS entry (an empty entry is a keyless endpoint). Falls back to OPENAI_API_KEY; with fewer keys than URLs the missing ones are empty, and extra keys are dropped, as Open WebUI does.",
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
		desc: "The Hugging Face sign-in's issuer. Beside OAUTH_CLIENT_ID it is instead Open WebUI's name for OIDC_ISSUER, the organisation sign-in's discovery URL (CUR-4858).",
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
	// per address per 24h, and 1000/24h site-wide to addresses with no account, a circuit breaker.
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
	PROBE_MARKER_TOKEN: {
		secret: true,
		desc: "Shared secret the scheduled production probes send as x-probe-token. A probe turn a screen declines then writes its safety_events row with the probe's name in safety_events.probe, so counts of real declines can leave it out. Unset, no row is marked and probe declines count as real ones.",
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
		site: true,
		bootReq: "site-deployment",
		desc: "Origin of the Payload CMS deployment. Public on purpose: every CMS read is public, and the browser resolves relative media URLs against it. Server-side page reads use it too. Required at boot only on the site surface of a production or preview deployment (`bootReq`); the chat surface and local dev boot without it, and the CMS is then left out of the CSP.",
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
		site: true,
		desc: "Origin the app is served from, for example http://localhost:5173. Sign-in builds its callback URLs and passkey RP ID from it.",
	},
	PUBLIC_PLAUSIBLE_SCRIPT_URL: {
		desc: "Plausible analytics script URL.",
	},
	PUBLIC_POSTHOG_HOST: {
		desc: "PostHog host for the browser. Default the same-origin /rs proxy, which forwards to POSTHOG_INGEST_HOST.",
	},
	PUBLIC_POSTHOG_KEY: {
		desc: "PostHog project token. Public by design (write-only). Unset, analytics are off.",
	},
	PUBLIC_POSTHOG_LEGACY_KEY: {
		desc: "The previous PostHog project token, set only while a project move settles (CUR-439). A browser with nothing stored under PUBLIC_POSTHOG_KEY starts from the distinct_id it had under this token (analytics.ts legacyDistinctId), so returning visitors are not counted as new. Unset, or equal to PUBLIC_POSTHOG_KEY, does nothing. Public by design, like the key it replaces.",
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
	RAG_RERANK_RELATIVE_RATIO: {
		desc: "A retrieved chunk must also score this share of the best chunk's reranker score. Default 0 (off).",
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
		desc: "Per-IP limit as a multiple of RATE_LIMIT. Default 200, so 4,000 a minute from one address. 0 turns the per-IP limit off.",
	},
	REASONING_SUMMARY: {
		desc: "\"true\" shows a summary of the model's reasoning.",
	},
	RESEND_API_KEY: {
		secret: true,
		warn: true,
		desc: "Resend key for sign-in code emails. Unset, codes are logged instead of sent and sign-in still works.",
	},
	SMTP_URL: {
		secret: true,
		desc: "SMTP server for sign-in code and invitation emails, as smtp(s)://user:pass@host:port. Used only when RESEND_API_KEY is unset (a self-hosted Alpha's own mail).",
	},
	SMTP_FROM: {
		desc: "Sender for SMTP_URL, e.g. \"Alpha <noreply@example.com>\". Unset, noreply at PUBLIC_ORIGIN's host.",
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
	RERANK_MAX_DOCS: {
		desc: "Most documents a web search gathers for the reranker; every engine's share shrinks to fit. Default 32. The self-host stack sets 12 for its CPU reranker.",
	},
	RERANK_DOC_CHARS: {
		desc: "Characters of each document the reranker scores. Default 1200.",
	},
	RERANK_TIMEOUT_MS: {
		desc: "How long a web search waits for the reranker before answering without sources. Default 6000.",
	},
	RERANK_SCORES: {
		desc: "Set to logits when the reranker returns raw logits (llama.cpp's /rerank does), so each score goes through a sigmoid before the 0-1 relevance floor. Unset, scores are read as 0-1.",
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
		desc: "The sequential panel's first seat. On a Vercel deployment config.ts serves ROLE_MODELS in config/inference.ts and ignores this var (CUR-2277); it decides only off Vercel (local dev, CI, evals).",
	},
	SEMANTIC_HEDGE_ENABLED: {
		desc: "\"false\" turns off the embedding check for hedged or evasive answers on grounded turns. Default on. Without it, the regex hedge check still runs.",
	},
	SEMANTIC_HEDGE_THRESHOLD: {
		desc: "Similarity a sentence must reach to count as a hedge or denial. Default 0.4.",
	},
	SHUTDOWN_TIMEOUT: {
		desc: "adapter-node only (self-hosted container): seconds to wait for open requests, chat streams included, after SIGTERM, and then again for background work (gracefulShutdown.ts). Default 30. Set the orchestrator's stop grace period to at least twice this. Unused on Vercel.",
	},
	SILENCE_TIMEOUT_MS: {
		desc: "How long a turn may go without a new token before it counts as stalled, in ms. Default 45000. Capped at that turn's own generation timeout. Needs a redeploy to change.",
	},
	SOVEREIGN_HOSTS: {
		warn: true,
		desc: "Comma-separated host=label pairs naming model hosts the UI may describe as sovereign.",
	},
	STATUS_PAGE_URL: {
		desc: "The Better Stack status page the chat's incident banner reads (its /index.json) and links to. Unset, a hosted or local process uses the deployment file's statusPageUrl (none by default), and a self-host (ALPHA_EDITION=selfhost) has no status page and shows no banner.",
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
		desc: "CI only: issue-tracker key for the CI job that syncs feature-flag state to tracker labels. Other CI jobs mint a token from CI_LINEAR_CLIENT_ID/_SECRET and fall back to this one. The app does not read it.",
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
		desc: "Vercel's Protection Bypass for Automation token (Project Settings → Deployment Protection). Set by the deployment, not by Vercel: without it, platform SSO answers the every-minute warm cron with 401 before the app runs, and the `db` warm leg stops keeping the database connection open during quiet hours (warm.ts). Also read directly by scripts/warm-cache.mjs. Exempt from the `^VERCEL_` platform-noise denylist in config/platform-noise.mjs, so `env-audit --prod` still lists it.",
	},
	WARM_THROTTLE_MS: {
		desc: "Test only: overrides every warm-up check's throttle window. Leave unset in every deployment; a large value suppresses health checks. A non-numeric or non-positive value is ignored.",
	},
	// Optional deploy knob for the per-inviting-user workspace-invite counter
	// (db/workspaceInviteRate.ts). Unset -> 20/24h, the default is correct with no committed
	// .env entry.
	WORKSPACE_INVITE_MAX_PER_DAY: {
		desc: "Workspace invites one account can send per day. Default 20.",
	},
	// Optional knob for an account under a week old (db/workspaceInviteRate.ts). Unset -> 5/24h,
	// capped at WORKSPACE_INVITE_MAX_PER_DAY, so a few fresh accounts can't spend the site-wide ceiling.
	WORKSPACE_INVITE_NEW_ACCOUNT_MAX_PER_DAY: {
		desc: "Workspace invites an account under a week old can send per day. Default 5, capped at WORKSPACE_INVITE_MAX_PER_DAY.",
	},
	// Optional knob for the site-wide workspace-invite ceiling (db/workspaceInviteRate.ts).
	// Unset -> 500/24h, a circuit breaker well above real use.
	WORKSPACE_INVITE_SITE_MAX_PER_DAY: {
		desc: "Workspace invites per day across the site. Default 500.",
	},
	WORLD_MODEL_PREPASS: {
		desc: "\"true\" turns on an experimental world-model verification pass before answering. Default off.",
	},
	ZENTROPI_S1_ENDPOINT_URL: {
		desc: "Base URL of the Zentropi S1 judge (`POST /v1/systemone`) that the `s1-safety-judge` flag turns on (detectors/s1.ts). Optional on Current AI's deployments: with DEPLOY_ENV (or VERCEL_ENV) production or preview and this unset, the endpoint is the committed `deployed_api_base` in web/config/safetyScreen.ts. Anywhere else (local dev, CI, a self-host) it is the only address: unset means the judge is not configured, and flag on logs an error and fails every turn closed, as it always has with HF_TOKEN unset. Set, it wins on every deployment.",
	},
};

const KEYS = Object.keys(ENV_MANIFEST).sort();
export const allKeys = () => KEYS.slice();
export const requiredKeys = () => KEYS.filter((k) => ENV_MANIFEST[k].req);
export const warnKeys = () => KEYS.filter((k) => ENV_MANIFEST[k].warn);

// The `req` keys whose absence must stop THIS server booting. `surface` is the build's APP_SURFACE
// ("site" | "chat"), `deployEnv` the declared deployment environment (deployEnv.ts; null when nothing
// declares one). A key without `bootReq` is fatal everywhere, exactly as `requiredKeys()`.
//
// "site-deployment" exists for PUBLIC_CMS_PAYLOAD_URL: only the site's CMS-backed pages need it, so a
// chat-surface build (alpha) and an undeclared or development environment (local dev, the public
// snapshot, which ships without the CMS) degrade instead of refusing to boot. Production and preview
// stay fatal because those are the deployments we operate that serve the CMS pages, and there a
// missing origin is a misconfiguration, not a choice.
//
// A `site-only` build serves no chat, so only the keys marked `site` are checked there at all.
const onSurface = (surface) => (k) => surface !== "site-only" || !!ENV_MANIFEST[k].site;
export const bootRequiredKeys = ({ surface, deployEnv }) =>
	requiredKeys().filter(onSurface(surface)).filter((k) => {
		const scope = ENV_MANIFEST[k].bootReq;
		if (scope === undefined) return true;
		if (scope === "site-deployment")
			return (
				(surface === "site" || surface === "site-only") &&
				(deployEnv === "production" || deployEnv === "preview")
			);
		if (scope === "production") return deployEnv === "production";
		// An unknown scope is a typo in this file; fail closed (fatal) rather than waive the key.
		return true;
	});
// The `req` keys this surface reads at all: every one, except on `site-only` (see above).
export const surfaceRequiredKeys = ({ surface }) => requiredKeys().filter(onSurface(surface));
// The `warn` keys this server's boot logs as missing: every one, except on `site-only` (see above).
export const bootWarnKeys = ({ surface }) => warnKeys().filter(onSurface(surface));
export const isSecret = (k) =>
	!!ENV_MANIFEST[k]?.secret ||
	/(PASSWORD|SECRET|TOKEN|_KEY$|API_KEY|PEPPER|CREDENTIAL|PRIVATE)/i.test(k);
export const isPublic = (k) => k.startsWith("PUBLIC_");
