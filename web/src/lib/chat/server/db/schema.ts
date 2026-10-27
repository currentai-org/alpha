/**
 * Drizzle schema for the Postgres/Neon persistence layer (B1-lite migration off MongoDB).
 *
 * Strategy: a document store. Each former Mongo collection is a table of `id` (24-hex, ObjectId-width)
 * + the small set of columns it is actually *filtered/sorted* by (for indexes) + a `doc` JSONB column
 * holding the full document. The doc-store adapter (docStore.ts) reads/writes `doc` and keeps
 * the projection columns in sync. This lets the entire app — routes, tree utilities, components, and
 * the `_id: ObjectId` types — keep operating unchanged while the storage engine becomes Postgres.
 *
 * Dates and ObjectIds inside `doc` are persisted via an extended-JSON encoding (see docStore.ts)
 * so they round-trip faithfully anywhere in the document, including nested fields like
 * session.oauth.token.expiresAt.
 *
 * Written from chat-ui's own TypeScript interfaces — NOT copied from any Vercel reference.
 * Kept free of $lib/chat/$app aliases so it is importable by a plain Node verification harness.
 */
import {
	pgTable,
	text,
	jsonb,
	timestamp,
	customType,
	index,
	uniqueIndex,
	integer,
	boolean,
	real,
	date,
	primaryKey,
	foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ANSWER_REPORT_REASON_KEYS, REPORT_STATUS_KEYS } from "../../reportReasons";

// Postgres bytea for binary file payloads (GridFS replacement).
const bytea = customType<{ data: Buffer; default: false }>({
	dataType() {
		return "bytea";
	},
});

type Doc = Record<string, unknown>;

// ── conversations ──────────────────────────────────────────────────────────────
export const conversations = pgTable(
	"conversations",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id"),
		// The shadow `users.id` (auth.ts's bridge), never Better Auth's own `user.id`. No cascade:
		// wipeUserData.ts deletes these rows before the `users` row, so a delete that skips the wipe fails. (CUR-769)
		userId: text("user_id").references(() => users.id),
		createdAt: timestamp("created_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true }),
		// Attribution, not ownership (CUR-961), qualifying the "conversations stay unscoped on purpose"
		// line on ragDocuments' own organizationId comment below. Conversations aren't WORKSPACE PROPERTY
		// (CUR-736): an admin can't read one, a workspace delete can't take one down. A workspace's usage
		// count is computed from this column rather than by joining on membership, which would expose a
		// member's usage elsewhere to the admin. NULL for anything outside a workspace context or
		// created before this column existed (no retrofit: a conversation didn't happen "in" a
		// workspace it predates), never read for content, only for which workspace's usage count a
		// conversation contributes to. onDelete "set null", NOT "cascade" like ragDocuments' column —
		// deleting a workspace must never delete a member's own conversation, only detach it.
		organizationId: text("organization_id").references(() => organization.id, { onDelete: "set null" }),
		doc: jsonb("doc").$type<Doc>().notNull(),
	},
	(t) => [
		index("conversations_session_updated_idx").on(t.sessionId, t.updatedAt.desc()),
		index("conversations_user_updated_idx").on(t.userId, t.updatedAt.desc()),
		// Serves the retention sweep's `updated_at < cutoff` predicate (db/cleanup.ts); the composite
		// indexes above lead with session/user so they can't answer a bare time-range scan.
		index("conversations_updated_idx").on(t.updatedAt),
		// workspaceUsage.ts's own scoping query, same shape as the session/user indexes above. (CUR-961)
		index("conversations_org_updated_idx").on(t.organizationId, t.updatedAt.desc()),
	]
);

// ── users ────────────────────────────────────────────────────────────────────
export const users = pgTable(
	"users",
	{
		id: text("id").primaryKey(),
		hfUserId: text("hf_user_id"),
		username: text("username"),
		createdAt: timestamp("created_at", { withTimezone: true }),
		doc: jsonb("doc").$type<Doc>().notNull(),
	},
	(t) => [
		uniqueIndex("users_hf_user_id_idx").on(t.hfUserId),
		index("users_username_idx").on(t.username),
	]
);

// ── sessions ─────────────────────────────────────────────────────────────────
export const sessions = pgTable(
	"sessions",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id").notNull(),
		// The shadow `users.id` (auth.ts's bridge), never Better Auth's own `user.id`. No cascade:
		// wipeUserData.ts deletes these rows before the `users` row, so a delete that skips the wipe fails. (CUR-769)
		userId: text("user_id").references(() => users.id),
		// Postgres has no native TTL; expiry is enforced by query + a cleanup job (replaces Mongo TTL index).
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		doc: jsonb("doc").$type<Doc>().notNull(),
	},
	(t) => [
		uniqueIndex("sessions_session_id_idx").on(t.sessionId),
		index("sessions_expires_idx").on(t.expiresAt),
	]
);

// ── Better Auth: identity & session (CUR-434/CUR-432) ────────────────────────────
// Better Auth owns identity end-to-end — passkey, email-OTP, Google, and (via genericOAuth) Hugging
// Face all resolve through it, including its native account-linking-by-verified-email. These are
// Better Auth's OWN default (singular) table names, chosen deliberately: they cannot collide with this
// file's existing plural `users`/`sessions` doc-store tables above, which become a compat SHADOW keyed
// 1:1 to `user.id` — kept only because the rest of the app already reads `locals.user` in that shape
// (see the bridge branch in server/auth.ts's authenticateRequest).
//
// The EXPORTED CONST NAME here is load-bearing, not cosmetic: @better-auth/drizzle-adapter resolves a
// model via `schema[modelName]` against this module's exports (usePlural defaults to false), so these
// must be named exactly `user`/`session`/`account`/`verification`/`passkey` — not aliased — or the
// adapter throws "model not found" at runtime.
//
// Field shape (names, nullability, indexes) is copied from the INSTALLED package source, not assumed
// from memory — it varies across Better Auth versions (e.g. `account.issuer` is new in 1.7.1):
// node_modules/@better-auth/core/src/db/get-tables.ts (user/session/account/verification) and
// @better-auth/passkey's dist/index.mjs `schema` export (passkey). Re-check both before bumping
// better-auth's version if any of this ever needs to change.
export const user = pgTable(
	"user",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		email: text("email").notNull(),
		emailVerified: boolean("email_verified").notNull().default(false),
		image: text("image"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
		// The workspace this person last made active (null is Personal), so a new session
		// can start there. This app's own column, not Better Auth's, written and read only by
		// resumeWorkspace.ts. No foreign key: a deleted workspace leaves a stale id, which the
		// membership check on read already treats as Personal. (CUR-3024)
		lastActiveOrganizationId: text("last_active_organization_id"),
		// Better Auth's admin plugin (betterAuth.ts) reads and writes these four, field shape
		// copied from the installed plugin's schema (better-auth/dist/plugins/admin/schema.mjs). `role`
		// is what adminRoles.ts grants permissions from; null means no staff role. (CUR-3990)
		role: text("role"),
		banned: boolean("banned").default(false),
		banReason: text("ban_reason"),
		banExpires: timestamp("ban_expires", { withTimezone: true }),
	},
	(t) => [uniqueIndex("user_email_idx").on(t.email)]
);

export const session = pgTable(
	"session",
	{
		id: text("id").primaryKey(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		token: text("token").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		// The organization plugin (below) writes this unconditionally on accept-invitation and
		// on create (unless keepCurrentActiveOrganization is passed) — required:false/input:false in the
		// plugin's OWN schema declaration (organization.mjs), copied here rather than assumed. This app
		// never reads it (every org.ts call passes an explicit organizationId), but the column has to
		// exist or those writes fail against a schema that doesn't know the field. (CUR-550)
		activeOrganizationId: text("active_organization_id"),
		// The admin plugin's impersonation marker. No role is granted impersonation, so this
		// stays null, but the plugin's session hooks read the column. (CUR-3990)
		impersonatedBy: text("impersonated_by"),
	},
	(t) => [uniqueIndex("session_token_idx").on(t.token), index("session_user_idx").on(t.userId)]
);

export const account = pgTable(
	"account",
	{
		id: text("id").primaryKey(),
		// Nullable, and no longer an identity key: Better Auth 1.7.3+ keys an account by (provider_id,
		// account_id) and stops writing this column (CUR-2602). Drop the column once no build writes it.
		issuer: text("issuer"),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		// Not returned to clients by Better Auth's own output filter — real secrets, at rest here.
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
		refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
		scope: text("scope"),
		// Unused: the email/password plugin (which is the only thing that ever populates this) is not
		// enabled — CUR-482 resolved to passkey + email-OTP instead, no password, ever. Kept because
		// it's part of Better Auth's core account schema regardless of which plugins are active.
		password: text("password"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		// One row per provider identity; it replaces the issuer-keyed index, so a doubled OAuth callback
		// still cannot insert the same provider account twice (CUR-4159).
		uniqueIndex("account_provider_account_idx").on(t.providerId, t.accountId),
		index("account_user_idx").on(t.userId),
	]
);

export const verification = pgTable(
	"verification",
	{
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("verification_identifier_idx").on(t.identifier)]
);

// The passkey plugin's own table (@better-auth/passkey) — a separate package from core Better Auth,
// so it declares its own schema and does NOT set onDelete:cascade on userId the way the core
// session/account tables do above. Matched here exactly rather than added on top: deleting a user's
// passkeys is that plugin's own responsibility at the application layer, not a DB-cascade guarantee —
// wipeUserData.ts must delete this table explicitly rather than assume a cascade will do it.
export const passkey = pgTable(
	"passkey",
	{
		id: text("id").primaryKey(),
		name: text("name"),
		publicKey: text("public_key").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id),
		credentialID: text("credential_id").notNull(),
		counter: integer("counter").notNull(),
		deviceType: text("device_type").notNull(),
		backedUp: boolean("backed_up").notNull(),
		transports: text("transports"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
		aaguid: text("aaguid"),
	},
	(t) => [index("passkey_user_idx").on(t.userId), index("passkey_credential_idx").on(t.credentialID)]
);

// ── Better Auth: organization plugin (workspaces, CUR-550) ────────────────────────
// A workspace IS a Better Auth "organization" — creatorRole is set to "admin" in betterAuth.ts (not
// the plugin's own "owner" default), and this app never invites, promotes, or displays anyone as
// "owner", so the product surface only ever shows the two roles CUR-550 asks for. Field shapes below
// are copied from the INSTALLED package's own schema declaration (organization.mjs's `schema` object),
// not assumed — same discipline as the user/session/account/verification/passkey block above. Table
// names are Better Auth's own singular defaults (modelName unset), matching that block's convention.
export const organization = pgTable(
	"organization",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		logo: text("logo"),
		// Stored as a JSON string (Better Auth's own convention) — parsed by the plugin on read, never
		// read directly by this app.
		metadata: text("metadata"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		// ── CUR-826: the three switches every workspace carries ──────────────────────────────
		// App-owned fields, not Better Auth's — registered as `schema.organization.additionalFields`
		// in betterAuth.ts so the plugin's own create/update/get-full-organization endpoints read and
		// write them, rather than a parallel table only this app's own routes would know to join.
		// Canonical value lists + labels live in $lib/chat/workspacePermissions.ts (not under server/ —
		// the settings page reads it client-side too) — nothing outside that module should compare
		// against a bare string literal (the whole point of CUR-826: "no screen hardcodes a value").
		//
		// Defaults match CUR-550's actual shipped behavior exactly, so this migration changes no
		// existing workspace's real permissions — only "invitation" and "admin_only" have a live
		// mechanism behind them today (invite-by-email, and Better Auth's own admin/member ac). "request",
		// "open", and the two "members_propose_*" values are legal, storable, and DISPLAYED, but nothing
		// in this codebase acts on them yet — that's CUR-551 (admin config screen) and CUR-554 (member
		// change-requests), both the trust-and-safety lead's, not built here.
		joinMethod: text("join_method", { enum: ["invitation", "request", "open"] })
			.notNull()
			.default("invitation"),
		configChangeRule: text("config_change_rule", {
			enum: ["admin_only", "members_propose_admin_approves", "members_propose_auto_apply"],
		})
			.notNull()
			.default("admin_only"),
		// Only one legal value today — modeled as a real column (not a hardcoded constant) per the
		// ticket's own "the three switches exist on the workspace record", so a future product decision
		// to make this configurable is a value addition, not a schema migration.
		rulesVisibility: text("rules_visibility", { enum: ["always"] }).notNull().default("always"),
	},
	(t) => [uniqueIndex("organization_slug_idx").on(t.slug)]
);

export const member = pgTable(
	"member",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		role: text("role").notNull().default("member"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(t) => [
		index("member_organization_idx").on(t.organizationId),
		index("member_user_idx").on(t.userId),
	]
);

export const invitation = pgTable(
	"invitation",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		email: text("email").notNull(),
		role: text("role"),
		status: text("status").notNull().default("pending"),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		// Better Auth's own schema declares this required with no onDelete (organization.mjs) — left as
		// NO ACTION there would block deleting a `user` row that has ever sent an invitation (a real FK
		// violation in wipeUserData's account-wipe path, caught by wipeCoverage.spec.ts). Cascading here
		// is this app's own choice, not the plugin's: an invitation from someone who no longer exists
		// isn't acceptable anyway, so it disappearing with its inviter is the correct behavior, not a
		// gap — matching `member`'s own cascade-on-user-delete choice just above.
		inviterId: text("inviter_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(t) => [
		index("invitation_organization_idx").on(t.organizationId),
		index("invitation_email_idx").on(t.email),
	]
);

// ── Better Auth: OAuth 2.1 provider plugin (Thunderbolt sync, CUR-4312) ─────────────────────────
// Alpha as an authorization server, so a registered client (the Thunderbolt sandbox,
// config/thunderbolt.ts) can hold a token for /chat/api/v2/sync/* and nothing else. Field shapes are
// copied from the installed plugin's schema (@better-auth/oauth-provider dist/authorize-*.mjs,
// `const schema`); oauthProviderSchema.spec.ts fails when the plugin writes a field no column holds.
// Every reference to `user` cascades, which is this app's choice and not the plugin's: an account
// wipe deletes the `user` row, and a grant outliving its person would block that delete.
export const oauthClient = pgTable(
	"oauth_client",
	{
		id: text("id").primaryKey(),
		// Unique inline rather than as a uniqueIndex: four tables' foreign keys point at it, and drizzle-kit
		// writes index statements after the constraints that would need them.
		clientId: text("client_id").notNull().unique("oauth_client_client_id_unique"),
		clientSecret: text("client_secret"),
		clientDiscoveryId: text("client_discovery_id"),
		disabled: boolean("disabled").default(false),
		skipConsent: boolean("skip_consent"),
		enableEndSession: boolean("enable_end_session"),
		subjectType: text("subject_type"),
		scopes: text("scopes").array(),
		clientCredentialsScopes: text("client_credentials_scopes").array().default(sql`'{}'::text[]`),
		userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true }),
		name: text("name"),
		uri: text("uri"),
		icon: text("icon"),
		contacts: text("contacts").array(),
		tos: text("tos"),
		policy: text("policy"),
		softwareId: text("software_id"),
		softwareVersion: text("software_version"),
		softwareStatement: text("software_statement"),
		redirectUris: text("redirect_uris").array().notNull(),
		postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
		backchannelLogoutUri: text("backchannel_logout_uri"),
		backchannelLogoutSessionRequired: boolean("backchannel_logout_session_required"),
		tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
		applicationType: text("application_type"),
		jwks: text("jwks"),
		jwksUri: text("jwks_uri"),
		grantTypes: text("grant_types").array(),
		responseTypes: text("response_types").array(),
		requirePKCE: boolean("require_pkce"),
		dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
		referenceId: text("reference_id"),
		metadata: jsonb("metadata"),
	},
	(t) => [index("oauth_client_user_idx").on(t.userId)]
);

export const oauthResource = pgTable(
	"oauth_resource",
	{
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull().unique("oauth_resource_identifier_unique"),
		name: text("name").notNull(),
		accessTokenTtl: integer("access_token_ttl"),
		refreshTokenTtl: integer("refresh_token_ttl"),
		signingAlgorithm: text("signing_algorithm"),
		signingKeyId: text("signing_key_id"),
		allowedScopes: text("allowed_scopes").array(),
		customClaims: jsonb("custom_claims"),
		dpopBoundAccessTokensRequired: boolean("dpop_bound_access_tokens_required").default(false),
		disabled: boolean("disabled").default(false),
		createdAt: timestamp("created_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true }),
		policyVersion: integer("policy_version").default(1),
		metadata: jsonb("metadata"),
	}
);

export const oauthClientResource = pgTable(
	"oauth_client_resource",
	{
		id: text("id").primaryKey(),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		resourceId: text("resource_id")
			.notNull()
			.references(() => oauthResource.identifier, { onDelete: "cascade" }),
		metadata: jsonb("metadata"),
		createdAt: timestamp("created_at", { withTimezone: true }),
	},
	(t) => [
		index("oauth_client_resource_client_idx").on(t.clientId),
		index("oauth_client_resource_resource_idx").on(t.resourceId),
	]
);

export const oauthRefreshToken = pgTable(
	"oauth_refresh_token",
	{
		id: text("id").primaryKey(),
		token: text("token").notNull(),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		referenceId: text("reference_id"),
		authorizationCodeId: text("authorization_code_id"),
		resources: text("resources").array(),
		requestedUserInfoClaims: text("requested_user_info_claims").array(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		revoked: timestamp("revoked", { withTimezone: true }),
		rotatedAt: timestamp("rotated_at", { withTimezone: true }),
		rotationReplayResponse: text("rotation_replay_response"),
		rotationReplayExpiresAt: timestamp("rotation_replay_expires_at", { withTimezone: true }),
		authTime: timestamp("auth_time", { withTimezone: true }),
		confirmation: jsonb("confirmation"),
		scopes: text("scopes").array().notNull(),
	},
	(t) => [
		uniqueIndex("oauth_refresh_token_token_idx").on(t.token),
		index("oauth_refresh_token_client_idx").on(t.clientId),
		index("oauth_refresh_token_session_idx").on(t.sessionId),
		index("oauth_refresh_token_user_idx").on(t.userId),
		index("oauth_refresh_token_code_idx").on(t.authorizationCodeId),
	]
);

export const oauthAccessToken = pgTable(
	"oauth_access_token",
	{
		id: text("id").primaryKey(),
		token: text("token").notNull(),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
		userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
		referenceId: text("reference_id"),
		authorizationCodeId: text("authorization_code_id"),
		resources: text("resources").array(),
		requestedUserInfoClaims: text("requested_user_info_claims").array(),
		refreshId: text("refresh_id").references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		revoked: timestamp("revoked", { withTimezone: true }),
		confirmation: jsonb("confirmation"),
		scopes: text("scopes").array().notNull(),
	},
	(t) => [
		uniqueIndex("oauth_access_token_token_idx").on(t.token),
		index("oauth_access_token_client_idx").on(t.clientId),
		index("oauth_access_token_session_idx").on(t.sessionId),
		index("oauth_access_token_user_idx").on(t.userId),
		index("oauth_access_token_code_idx").on(t.authorizationCodeId),
		index("oauth_access_token_refresh_idx").on(t.refreshId),
	]
);

export const oauthConsent = pgTable(
	"oauth_consent",
	{
		id: text("id").primaryKey(),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
		referenceId: text("reference_id"),
		resources: text("resources").array(),
		requestedUserInfoClaims: text("requested_user_info_claims").array(),
		scopes: text("scopes").array().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("oauth_consent_client_idx").on(t.clientId), index("oauth_consent_user_idx").on(t.userId)]
);

// A private_key_jwt client assertion's jti, kept until it expires so it cannot be replayed. No client
// registered here authenticates that way, but the plugin's token endpoint declares the model.
export const oauthClientAssertion = pgTable("oauth_client_assertion", {
	id: text("id").primaryKey(),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// ── settings ─────────────────────────────────────────────────────────────────
// Wide/volatile shape (many per-model override maps) → kept entirely in `doc`.
export const settings = pgTable(
	"settings",
	{
		id: text("id").primaryKey(),
		// The shadow `users.id` (auth.ts's bridge), never Better Auth's own `user.id`. No cascade:
		// wipeUserData.ts deletes these rows before the `users` row, so a delete that skips the wipe fails. (CUR-769)
		userId: text("user_id").references(() => users.id),
		sessionId: text("session_id"),
		doc: jsonb("doc").$type<Doc>().notNull(),
	},
	(t) => [
		uniqueIndex("settings_user_idx").on(t.userId),
		uniqueIndex("settings_session_idx").on(t.sessionId),
	]
);

// ── messageEvents (rate-limit / resumable-stream infra) ──────────────────────────
export const messageEvents = pgTable(
	"message_events",
	{
		id: text("id").primaryKey(),
		userId: text("user_id"),
		// Keyed HMAC of the client IP (domain "rate-limit"), never the raw IP — see db/ipHash.ts.
		ipHash: text("ip_hash"),
		type: text("type"),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }),
		doc: jsonb("doc").$type<Doc>().notNull(),
	},
	(t) => [
		index("message_events_user_idx").on(t.userId, t.type, t.expiresAt),
		index("message_events_ip_hash_idx").on(t.ipHash, t.type, t.expiresAt),
	]
);

// ── abortedGenerations (cross-instance stop marker) ──────────────────────────────
export const abortedGenerations = pgTable(
	"aborted_generations",
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id"),
		updatedAt: timestamp("updated_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }),
		doc: jsonb("doc").$type<Doc>().notNull(),
	},
	(t) => [uniqueIndex("aborted_generations_conversation_idx").on(t.conversationId)]
);

// ── mcpElicitations (parked mid-tool-call question, CUR-1017) ────────────────────
// A 2026-era MCP server answers a tool call with `input_required` and its own request ends
// immediately — nothing is blocked waiting anywhere (unlike a 2025-era server's blocking
// `elicitation/create`, which this repo deliberately does not support: the platform kill at
// generationDeadline.ts's documented 300s maxDuration makes holding a Vercel invocation open
// across a human-decision gap a non-starter, not just harder than upstream's pod case). This
// table is the "write now, read later" primitive that replaces holding anything open — no poll
// loop needed the way abortedGenerations needs one, since nothing is ever waiting on a row here;
// it's read on demand by the answer-submission route.
export const mcpElicitations = pgTable(
	"mcp_elicitations",
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id"),
		updatedAt: timestamp("updated_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }),
		doc: jsonb("doc").$type<Doc>().notNull(),
	},
	(t) => [index("mcp_elicitations_conversation_idx").on(t.conversationId)]
);

// ── semaphores (advisory lock + config-update marker) ────────────────────────────
// `key` is unique: insert throwing on duplicate IS the lock primitive (see dbLock.ts).
export const semaphores = pgTable(
	"semaphores",
	{
		id: text("id").primaryKey(),
		key: text("key").notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }),
		deleteAt: timestamp("delete_at", { withTimezone: true }),
		doc: jsonb("doc").$type<Doc>().notNull(),
	},
	(t) => [uniqueIndex("semaphores_key_idx").on(t.key)]
);

// ── tokenCaches (API bearer-token → user cache, 5-min TTL) ───────────────────────
export const tokenCaches = pgTable(
	"token_caches",
	{
		id: text("id").primaryKey(),
		tokenHash: text("token_hash"),
		userId: text("user_id"),
		createdAt: timestamp("created_at", { withTimezone: true }),
		doc: jsonb("doc").$type<Doc>().notNull(),
	},
	(t) => [index("token_caches_hash_idx").on(t.tokenHash)]
);

// ── config (key/value, ConfigManager) ────────────────────────────────────────────
// Identity is `key` (not `_id`); no ObjectId is emitted on read.
export const configKv = pgTable("config", {
	key: text("key").primaryKey(),
	doc: jsonb("doc").$type<Doc>().notNull(),
});

// ── files (GridFS replacement; bytea payload) ────────────────────────────────────
// Not accessed through the Mongo adapter — see files/uploadFile.ts / downloadFile.ts.
export const files = pgTable(
	"files",
	{
		id: text("id").primaryKey(),
		filename: text("filename").notNull(),
		conversationId: text("conversation_id"),
		mime: text("mime"),
		data: bytea("data").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("files_filename_idx").on(t.filename)]
);

// ── reports (ROOST triage seam — normalized, NOT behind the Mongo adapter) ───────
// The single read/write point a trust-and-safety consumer attaches to. Written by saveReport
// (db/reports.ts). Mirrors the Vercel app's `Report` table adapted to text ids.
// TWO channels land here: a per-ANSWER report (conversationId + reason set, the report button) and a
// GENERAL "report a problem with the chat" (category set, conversationId/reason null — a bug/UX/content
// report not tied to one answer). conversationId + reason are therefore nullable; a row has EITHER a
// reason (answer report) OR a category (general report).
export const reports = pgTable(
	"reports",
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id").references(() => conversations.id),
		messageId: text("message_id"),
		userId: text("user_id"),
		sessionId: text("session_id"),
		// per-ANSWER reason (the report button). Null on a general report.
		reason: text("reason", { enum: ANSWER_REPORT_REASON_KEYS }),
		// GENERAL "report a problem" category. Null on a per-answer report.
		category: text("category", { enum: ["bug", "ux", "content", "other"] }),
		detail: text("detail"),
		// The reported answer as it read when reported, and the model that served it (CUR-997).
		// Deleting a conversation detaches its reports and keeps them, so without these a retained
		// report would no longer say what was wrong. Null on a general report.
		answerText: text("answer_text"),
		answerModel: text("answer_model"),
		// What staff decided, set from /admin/reports and shown back to the reporter on
		// /settings/reports (CUR-3903), so a report doesn't vanish after the thank-you line.
		status: text("status", { enum: REPORT_STATUS_KEYS }).notNull().default("received"),
		statusUpdatedAt: timestamp("status_updated_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("reports_conversation_idx").on(t.conversationId),
		index("reports_user_idx").on(t.userId),
		index("reports_session_idx").on(t.sessionId),
	]
);

export type ReportRow = typeof reports.$inferSelect;

// ── safety_events (Coop moderation declines) ──────────────────────────────────────────
// Append-only log of turns the in-app safety gate DECLINED. Distinct from `reports` (user-submitted
// feedback) and from `message_events` (rate-limit infra): this is trust-&-safety activity, surfaced
// in /admin/safety and RETAINED on a user data wipe (the safety carve-out). Stores ONLY the verdict
// metadata — never the user's text.
export const safetyEvents = pgTable(
	"safety_events",
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id"),
		messageId: text("message_id"),
		userId: text("user_id"),
		sessionId: text("session_id"),
		// which gate fired: Coop child-safety, in-app prompt-injection, or Coop content policy.
		kind: text("kind", {
			enum: ["child_safety", "prompt_injection", "content_policy", "toxicity"],
		}).notNull(),
		label: text("label"),
		score: real("score"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("safety_events_created_idx").on(t.createdAt)]
);
export type SafetyEventRow = typeof safetyEvents.$inferSelect;

// ── guard_daily_counts (log-action guard hits, counted per UTC day) ──────────────────────────
// The self-harm distress rules are log hits, which answer under the support card. A per-hit
// record of one, however stripped, can be joined back to the person by its time and the serverless
// instance it came from, and would then be health data. So a hit is only counted: one row per day and
// rule, with no id, no timestamp finer than the day, and nothing that orders the hits within it. (CUR-3915)
export const guardDailyCounts = pgTable(
	"guard_daily_counts",
	{
		day: date("day").notNull(),
		ruleKey: text("rule_key").notNull(),
		count: integer("count").notNull().default(0),
	},
	(t) => [primaryKey({ columns: [t.day, t.ruleKey] })]
);

// ── turn_outcomes (per-turn terminal outcome, for the outcome-RATE alert) ────────────────
// One row per terminal turn, written best-effort from the `[turn] outcome` site. It exists because
// no existing table answers "what fraction of real turns did not produce an answer": generations.status
// collapses to complete|error and marks an interrupted/empty turn `complete` (generations.ts:55), which
// is exactly the failure it would have to catch. The `[turn] outcome` line has the right
// taxonomy but lives in Axiom, which the warm cron cannot read. So the rate is derived here instead.
// Rows are pruned to a short retention by the warm cron — an alerting table must not become the
// conversations-table problem (mostly load-test rows). `declineKind` is broken out so `child_safety`
// stays greppable, though its rate already has its own probe (moderation:failclosed).
export const turnOutcomes = pgTable(
	"turn_outcomes",
	{
		id: text("id").primaryKey(),
		// complete | error | timedOut | aborted | shed | declined | empty — the taxonomy from
		// $lib/chat/utils/outcomeLadder (it was inline in routes/chat/conversation/[id]/+server.ts until
		// CUR-445). NOT constrained to an enum here: a new outcome value must widen the aggregate quietly
		// rather than fail an insert on the hot turn path — `empty` arrived through exactly that door.
		outcome: text("outcome").notNull(),
		declineKind: text("decline_kind"),
		// Request start to the first released token, the message's own `timings.ttftMs`; null when no token
		// streamed. The first-token median probe reads it on completed turns (CUR-2243).
		ttftMs: integer("ttft_ms"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("turn_outcomes_created_idx").on(t.createdAt)]
);
export type TurnOutcomeRow = typeof turnOutcomes.$inferSelect;

// ── admin_audit (admin action log) ────────────────────────────────────────────────────
// Append-only log of admin-area actions so config changes can be reconstructed and access reviewed.
// Privacy/security conscious: WHO (admin username), WHAT (action + target), a REDACTED summary (e.g.
// which keys changed — never secret values or full config payloads), and a HASHED IP. Retained.
export const adminAudit = pgTable(
	"admin_audit",
	{
		id: text("id").primaryKey(),
		actor: text("actor").notNull(),
		action: text("action").notNull(),
		target: text("target"),
		summary: text("summary"),
		ipHash: text("ip_hash"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("admin_audit_created_idx").on(t.createdAt)]
);
export type AdminAuditRow = typeof adminAudit.$inferSelect;
export type NewReportRow = typeof reports.$inferInsert;

// ── contributions ("Get involved" capture) ──────────────────────────────────────
// Public contribution write point — the single place "Stay informed" (subscribe) and
// "Raise your hand" (contribute) submissions land. Written by saveContribution
// (db/contributions.ts). Carries an `ip` column holding the pseudonymised client IP (see ipHash.ts),
// so the per-IP daily cap is counted in the DB.
export const contributions = pgTable(
	"contributions",
	{
		id: text("id").primaryKey(),
		// `data_interest`: "tell us you want to help with [language] data" (contribute page, composer
		// language panel, report follow-up). Counted per `language`; the email is optional for it.
		// `model_suggestion`: "know a model that does [language] well?" from the same form, with the
		// model as the person wrote it in `detail`.
		kind: text("kind", { enum: ["subscribe", "contribute", "data_interest", "model_suggestion"] }).notNull(),
		email: text("email"),
		name: text("name"),
		organization: text("organization"),
		contributionType: text("contribution_type", {
			enum: ["compute", "data", "code", "funding", "other"],
		}),
		detail: text("detail"),
		/** Routing language tag (ISO 639-3, optional variety) of a `data_interest` row. */
		language: text("language"),
		userId: text("user_id"),
		// Keyed HMAC of the client IP, never the raw IP (see db/ipHash.ts) — privacy-first per-IP
		// daily-cap key. Honest column name so nothing downstream mistakes it for a raw address.
		ipHash: text("ip_hash"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("contributions_ip_hash_created_idx").on(t.ipHash, t.createdAt)]
);

export type ContributionRow = typeof contributions.$inferSelect;
export type NewContributionRow = typeof contributions.$inferInsert;
export type FileRow = typeof files.$inferSelect;

// ── generations (W2 idempotency ledger) ──────────────────────────────────────────
// One row per client-minted generationId (the turn's idempotency key). Lets a re-sent POST — a
// network auto-retry of the SAME logical turn (W3) — be deduplicated instead of spawning a parallel
// run. The claim is one statement: INSERT … ON CONFLICT (id) DO UPDATE … WHERE status='error', which
// (a) inserts a fresh row, (b) re-claims a previously-errored row for a new attempt, or (c) no-ops when
// a complete/in-flight row already exists — in case (c) the route returns 409 and the client attaches
// to the existing run rather than double-submitting. Not a document collection (no `doc`/Mongo adapter):
// written via raw drizzle in $lib/chat/server/generations.ts. Pruned alongside conversations (db/cleanup.ts).
export const generations = pgTable(
	"generations",
	{
		id: text("id").primaryKey(), // = client-minted generationId (uuid); the PK IS the idempotency key
		conversationId: text("conversation_id").notNull(),
		messageId: text("message_id"), // assistant message this run wrote (reference)
		status: text("status", { enum: ["in_flight", "complete", "error"] }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(t) => [index("generations_conversation_idx").on(t.conversationId, t.createdAt)]
);

export type GenerationRow = typeof generations.$inferSelect;

// ── rag_documents (admin RAG upload — parent item) ───────────────────────────────
// First-class normalized table (NOT the Mongo-shaped doc-store): the admin-authored
// content path for the local "Potluck" RAG store. One row per uploaded item; its
// embedded chunks live in rag_chunks. status drives the retrieval gate — only `active`
// documents' chunks are read on the per-turn hot path. `version` is the optimistic-
// concurrency token (monotonic, incremented every write); editedAt records the last edit.
export const ragDocuments = pgTable(
	"rag_documents",
	{
		id: text("id").primaryKey(),
		title: text("title").notNull(),
		url: text("url"),
		// Human-readable provenance shown/attributed in the UI (e.g. "EPFL News", "OSAI gap map").
		source: text("source").notNull(),
		sourceType: text("source_type"), // free-form for now ("article" | "dataset" | "note" | …)
		sourceDate: timestamp("source_date", { withTimezone: true }),
		status: text("status", { enum: ["draft", "active", "retired"] })
			.notNull()
			.default("draft"),
		// Nullable FK: an admin authors most items, but a seed/import may have no user. Doubles as the
		// "uploader" that CUR-736's data rule #1 names ("admin or uploader may delete").
		createdBy: text("created_by").references(() => users.id),
		approvedBy: text("approved_by"), // stamped at activate (the approval gate)
		approvedAt: timestamp("approved_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
		// Timestamp of the last edit (display/audit). updatedAt feeds the adminStore watermark.
		editedAt: timestamp("edited_at", { withTimezone: true }),
		// Optimistic-concurrency token — a write supplies the version it read; a mismatch is a conflict.
		version: integer("version").notNull().default(1),
		// The workspace-scoping column (CUR-736): documents get an organizationId and conversations stay
		// unscoped on purpose.
		// NULL is the existing site-wide Potluck corpus (unchanged); a real value marks a workspace's own
		// document. onDelete:"cascade" means deleting an organization (CUR-827's admin delete) removes its
		// documents for free — same precedent as member/invitation, no explicit app-level delete loop.
		// `files` (chat attachments) deliberately does NOT get this column: it's keyed to conversationId,
		// and conversations stay unscoped per this same decision, so an attachment has no workspace to
		// belong to independent of its (unscoped) parent conversation.
		organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
	},
	(t) => [
		index("rag_documents_status_updated_idx").on(t.status, t.updatedAt.desc()),
		index("rag_documents_organization_idx").on(t.organizationId),
	]
);

export type RagDocumentRow = typeof ragDocuments.$inferSelect;
export type NewRagDocumentRow = typeof ragDocuments.$inferInsert;

// ── rag_chunks (one row per embedded chunk) ──────────────────────────────────────
// Retrieval is chunk-level, like the committed catalog index. `vector` is a real[]
// scanned in memory with the existing cosine() — no pgvector at this scale. `active`
// is DENORMALIZED from the parent's status (synced on every status transition) so the
// hot-path filter and a PARTIAL INDEX … WHERE active live on the chunk table (a partial
// index keyed on the parent's status is otherwise impossible). `contentHash` is a
// NON-unique index for a warn-only dedup at upload — a global UNIQUE would wrongly
// reject legitimately-identical text across documents or a re-upload after retirement.
export const ragChunks = pgTable(
	"rag_chunks",
	{
		id: text("id").primaryKey(),
		documentId: text("document_id")
			.notNull()
			.references(() => ragDocuments.id, { onDelete: "cascade" }),
		chunkIndex: integer("chunk_index").notNull(),
		text: text("text").notNull(),
		vector: real("vector").array().notNull(),
		embeddingModel: text("embedding_model").notNull(),
		dim: integer("dim").notNull(),
		contentHash: text("content_hash").notNull(),
		active: boolean("active").notNull().default(false),
	},
	(t) => [
		uniqueIndex("rag_chunks_doc_chunk_idx").on(t.documentId, t.chunkIndex),
		index("rag_chunks_content_hash_idx").on(t.contentHash),
		// Partial index over the live hot-path set: active chunks, keyed by embedding model
		// (the model-identity guard's filter). Keeps the per-turn reload selective.
		index("rag_chunks_active_model_idx")
			.on(t.embeddingModel)
			.where(sql`active`),
	]
);

export type RagChunkRow = typeof ragChunks.$inferSelect;
export type NewRagChunkRow = typeof ragChunks.$inferInsert;

// ── rag_document_audit (immutable history) ───────────────────────────────────────
// Every create/edit/activate/retire/reembed (mirrors tuning.ts's version-backup intent).
// documentId is a plain column, NOT a hard FK: the audit trail must survive a document
// deletion rather than cascade away with it.
export const ragDocumentAudit = pgTable(
	"rag_document_audit",
	{
		id: text("id").primaryKey(),
		documentId: text("document_id").notNull(),
		action: text("action", {
			enum: ["create", "edit", "activate", "retire", "reembed"],
		}).notNull(),
		byUser: text("by_user"),
		at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
		fromStatus: text("from_status"),
		toStatus: text("to_status"),
		snapshot: jsonb("snapshot").$type<Doc>(),
	},
	(t) => [index("rag_document_audit_document_idx").on(t.documentId, t.at.desc())]
);

export type RagDocumentAuditRow = typeof ragDocumentAudit.$inferSelect;
export type NewRagDocumentAuditRow = typeof ragDocumentAudit.$inferInsert;

// ── alert_state (ops-alert debounce/dedup — the SINGLE home for alerting state) ───────────────────
// Backs the ops-alert path: warm-cron health probes → alert webhook (server/alerting.ts + warm.ts). ONE ROW
// PER ALERT, keyed by an arbitrary `key` (e.g. "coop:verdict"). Every future alert — other health
// probes, the CUR-75 serving-backend-drift alert, error-rate alerts — reuses THIS table with a NEW KEY.
// Do NOT add a second alert-state table; add a row. First-class table (not the Mongo doc-store),
// written via a drizzle upsert in alerting.ts. Kept tiny and normalized — no `doc`. See CUR-35 + the
// "alerting" note in this file's header context / MIGRATION.md.
export const alertState = pgTable("alert_state", {
	// Alert identity, e.g. "coop:verdict". PK ⇒ one row per distinct alert; this IS the upsert key.
	key: text("key").primaryKey(),
	// Consecutive UNHEALTHY probes since the last healthy one — drives the fire threshold (a single
	// blip/cold-start never reaches it; sustained failure does).
	consecutiveFailures: integer("consecutive_failures").notNull().default(0),
	// True while an unresolved alert is outstanding — gates the recovery message + the re-alert debounce.
	firing: boolean("firing").notNull().default(false),
	// When we last POSTed a FIRING alert (the re-alert debounce reads this so an ongoing failure doesn't
	// re-notify every probe).
	lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AlertStateRow = typeof alertState.$inferSelect;
export type NewAlertStateRow = typeof alertState.$inferInsert;

// ── local_inference_endpoints — per-user LAN/local inference server (CUR-1194) ────────────────────
// Zero or more rows per user, each pointing a "local" conversation model at a personal, self-hosted
// OpenAI-compatible server (e.g. Ollama on localhost or a home-network box) — NOT a shared/org-wide
// custom deployment, which would be a different, global-scope feature built on the shared model
// registry instead of this per-row mechanism. Plain table, not the Mongo-doc-store shape (no `doc`)
// — same reasoning as alertState/turnOutcomes above: this is normalized data we filter by, not a
// legacy chat-ui document. Looked up per-request by userId (localInferenceEndpoints.ts) and spliced
// into a per-user model list — never merged into the shared, boot-once `models` registry. Each row's
// discovered models are namespaced by this row's own `id` in the internal model id
// (`local:{endpointId}:{servedModelId}`, see localModels.ts) so two servers reporting the same wire
// model tag never collide in the picker.
//
// Keyed on `userId` (the shadow `users.id`), not email (CUR-1262). `userId` is the SAME identity space
// every other per-user content table here keys on
// (settings.userId, conversations.userId, messageEvents.userId, contributions.userId — all populated
// from `authCondition(locals)`/`locals.user._id.toString()`, never Better Auth's own `user.id`
// directly, see the `user`/`users` split comment above). Email is a mutable attribute on the Better
// Auth `user` row, not a stable identity, and — unlike every sibling table — this feature has no
// anonymous/session-scoped case, so a real FK + cascade is a genuine improvement over the legacy
// tables' plain unconstrained `userId` rather than an inconsistency: it makes account deletion
// (wipeUserData.ts) actually reach this table instead of silently leaving a LAN endpoint behind.
//
// Non-unique on `userId`, so a user can register more than one server, matching the settings UI's
// list-of-servers design.
//
// One custom HTTP header sent with every request to this server (CUR-1291). Order-preserving array,
// not a map — a header name could legitimately repeat (rare, but HTTP allows it), and preserving
// entry order is cheap and never wrong.
export type LocalInferenceHeader = { name: string; value: string };

// A "managed" endpoint's baseUrl points at a reverse-tunnel provider's public resource
// URL (reached through a NAT-traversal control plane) instead of a URL the user typed themselves —
// see pangolinClient.ts. `provider` is a discriminant for a future second tunnel provider; today
// only "pangolin" exists. Plain `text`+`jsonb`, no DB-level enum — matches this file's existing
// convention (headers above, every other table here) of validating a small string set at the API
// layer (zod) rather than in Postgres. (CUR-1266)
export type ManagedEndpointConfig = {
	provider: "pangolin";
	siteId: number;
	niceId: string;
	resourceId: string;
};

export const localInferenceEndpoints = pgTable(
	"local_inference_endpoints",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// A user-chosen name for this server (e.g. "Workstation", "MacBook local") — shown in the
		// settings list and, once picked, as the model's display name.
		label: text("label").notNull(),
		// Full, ready-to-use OpenAI-compatible base URL (e.g. "http://localhost:11434/v1"), stored
		// exactly as it should be sent on the wire — normalized ONCE at write time (see
		// localModels.ts's normalizeLocalBaseUrl(), called from the create API route), not re-derived
		// at read time.
		baseUrl: text("base_url").notNull(),
		// A flat header list, not a single `apiKey` credential. One bearer credential covers only
		// the one auth shape every self-hosted OpenAI-compatible server happens NOT to need (Ollama has no
		// auth at all); a caller who does need one may need it under any header name (`Authorization`,
		// `X-API-Key`, a proxy-specific one), plus non-auth headers (a routing hint, a tenant id) that a single
		// credential cannot express. The single-credential case is one row named `Authorization`.
		//
		// Wired through create/list (localInferenceEndpoints.ts, api/v2/user/local-inference-endpoints),
		// the settings UI's Advanced Options panel, AND applied on every request to this endpoint
		// (discovery, prewarm, and generation — see localModels.ts's headersRecord()/defaultHeaders). (CUR-1291)
		headers: jsonb("headers").$type<LocalInferenceHeader[]>().notNull().default([]),
		// "direct" (default — the user supplies baseUrl themselves) or "managed" (baseUrl/headers
		// are populated by us from a tunnel provider's control-plane response; see the managed provisioning
		// route). (CUR-1266)
		kind: text("kind").notNull().default("direct"),
		// Only set for kind: "managed" — the tunnel provider's own object ids, needed to poll status
		// and to revoke (delete the site/resource) when the row is removed. Null for "direct" rows.
		managedConfig: jsonb("managed_config").$type<ManagedEndpointConfig | null>().default(null),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("local_inference_endpoints_user_idx").on(t.userId)]
);

export type LocalInferenceEndpointRow = typeof localInferenceEndpoints.$inferSelect;
export type NewLocalInferenceEndpointRow = typeof localInferenceEndpoints.$inferInsert;

// ── local_inference_pairings — the CLI's one-click pairing handoff (CUR-4110) ─────────────────────
// `aipotluck-local-client` makes up a random pairing id, opens chat/local-inference/pair?id=…&name=…
// in the browser, and polls api/v2/local-inference/pairings/<id> until this row carries credentials.
// The signed-in visit provisions a managed endpoint (managedInference/provision.ts) and parks its
// install flags here; the first poll takes them and nulls the column in the same UPDATE, so they are
// handed out exactly once. The row stays as a tombstone until `expiresAt`, so revisiting the link
// cannot provision a second device behind the CLI's back; cleanup.ts sweeps it after that.
//
// Keyed on a SHA-256 of the pairing id, never the id itself: the id is the only thing the poll route
// asks for, so it is a bearer secret, and a copy of this table should not be enough to collect from it.
// The row is created BEFORE provisioning (credentials null) so two loads of the same link race on the
// primary key, not on Pangolin: only the winner provisions.
export type LocalInferencePairingCredentials = {
	endpointId: string;
	label: string;
	installArgs: { tunnelId: string; tunnelSecret: string; tunnelEndpoint: string };
};

export const localInferencePairings = pgTable(
	"local_inference_pairings",
	{
		pairingIdHash: text("pairing_id_hash").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// Null while the claiming visit is still provisioning. Deleting the endpoint before the CLI
		// collects drops the pairing with it: its credentials would open a tunnel to nothing. The FK is
		// declared below with its own name, since drizzle's generated one runs past Postgres's 63 bytes.
		endpointId: text("endpoint_id"),
		// The tunnel secret lives here between the visit and the CLI's first poll, and nowhere after.
		credentials: jsonb("credentials").$type<LocalInferencePairingCredentials>(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		consumedAt: timestamp("consumed_at", { withTimezone: true }),
	},
	(t) => [
		index("local_inference_pairings_user_idx").on(t.userId),
		index("local_inference_pairings_expires_idx").on(t.expiresAt),
		foreignKey({
			name: "local_inference_pairings_endpoint_id_fk",
			columns: [t.endpointId],
			foreignColumns: [localInferenceEndpoints.id],
		}).onDelete("cascade"),
	]
);

export type LocalInferencePairingRow = typeof localInferencePairings.$inferSelect;

// ── human evaluation (A2, CUR-1913 / CUR-1914) ───────────────────────────────────────────────
// People who speak a language rate stored model answers to a fixed task set (humanEval/config.ts).
// Raw rows only: results are derived in humanEval/aggregate.ts and never stored.

// One stored model answer to one task in one language, generated by evals/inspect_tasks/eval_answers.py
// through the conversation API and loaded by scripts/import-eval-runs.mjs. Never overwritten: a new
// generation adds rows and sets `current = false` on the ones it replaces.
export const humanEvalRuns = pgTable(
	"human_eval_runs",
	{
		id: text("id").primaryKey(),
		taskSetVersion: text("task_set_version").notNull(),
		taskId: text("task_id").notNull(),
		language: text("language").notNull(),
		modelId: text("model_id").notNull(),
		// Where the provider exposes one. Null otherwise: provider plus createdAt stand in for it.
		modelRevision: text("model_revision"),
		provider: text("provider"),
		// The model the stream's routerMetadata named as having served the turn. A run where this does
		// not match modelId was served by a fallback and is imported with current = false.
		servedModel: text("served_model"),
		appBuild: text("app_build"),
		generationParams: jsonb("generation_params").$type<Record<string, unknown>>().notNull().default({}),
		prompt: text("prompt").notNull(),
		response: text("response").notNull(),
		// Automatic checks declared on the task (answer language, list length, kept values). Internal,
		// never shown to raters.
		autoChecks: jsonb("auto_checks").$type<Record<string, unknown>>().notNull().default({}),
		// A known-bad answer used to check raters read what they rate (humanEval/quality.ts). Never a
		// result. `checkSourceLanguage` is the language the answer is really in.
		isCheck: boolean("is_check").notNull().default(false),
		checkSourceLanguage: text("check_source_language"),
		current: boolean("current").notNull().default(true),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("human_eval_runs_lang_current_idx").on(t.language, t.current, t.taskSetVersion)]
);
export type HumanEvalRunRow = typeof humanEvalRuns.$inferSelect;

// What a person declares before rating in a language, and their consent. One row per person and
// language. `failedChecks` counts check items rated as good; see quality.ts for what it does.
export const humanEvalProfiles = pgTable(
	"human_eval_profiles",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		language: text("language").notNull(),
		level: text("level", { enum: ["native", "fluent", "working"] }).notNull(),
		// Declared variety where the language has several (pt-BR, pt-PT, es-419, ...). Optional.
		variety: text("variety"),
		consentVersion: text("consent_version").notNull(),
		consentedAt: timestamp("consented_at", { withTimezone: true }).notNull().defaultNow(),
		failedChecks: integer("failed_checks").notNull().default(0),
		calibrationSeenAt: timestamp("calibration_seen_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [uniqueIndex("human_eval_profiles_user_lang_idx").on(t.userId, t.language)]
);
export type HumanEvalProfileRow = typeof humanEvalProfiles.$inferSelect;

// One rating of one stored answer by one person. Every submission that passes validateRating is
// stored, and `validity` decides whether it counts. model/task/language are copied from the run so
// the aggregation is one scan.
export const humanEvalRatings = pgTable(
	"human_eval_ratings",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		runId: text("run_id")
			.notNull()
			.references(() => humanEvalRuns.id),
		language: text("language").notNull(),
		taskId: text("task_id").notNull(),
		modelId: text("model_id").notNull(),
		declaredLevel: text("declared_level", { enum: ["native", "fluent", "working"] }).notNull(),
		rubricVersion: text("rubric_version").notNull(),
		taskSetVersion: text("task_set_version").notNull(),
		scores: jsonb("scores").$type<Record<string, number | string>>().notNull(),
		flags: jsonb("flags").$type<string[]>().notNull().default([]),
		comment: text("comment"),
		durationMs: integer("duration_ms").notNull(),
		validity: text("validity", { enum: ["valid", "excluded", "quarantined"] }).notNull(),
		reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		// One person rates one answer once. The server refuses the second.
		uniqueIndex("human_eval_ratings_user_run_idx").on(t.userId, t.runId),
		index("human_eval_ratings_run_idx").on(t.runId),
		index("human_eval_ratings_lang_model_idx").on(t.language, t.modelId),
		index("human_eval_ratings_user_created_idx").on(t.userId, t.createdAt),
	]
);
export type HumanEvalRatingRow = typeof humanEvalRatings.$inferSelect;
export type NewHumanEvalRatingRow = typeof humanEvalRatings.$inferInsert;

// ── storageLocations (CUR-2930: a person's own bucket, linked as a place files can live) ──────
// One row per linked location. Alpha storage itself has no row: it is the location every account
// has, and `storage_preferences.default_location` null means it. `credential` is sealed with
// storage/locations/sealedSecret.ts and never leaves the server. Unlinking deletes the row, never
// the files in the person's bucket.
export type StorageLocationConfig = {
	// `buckets/<namespace>/<name>`, the same repo designation @huggingface/hub takes.
	repo: string;
	// A folder inside that bucket, `""` for the whole bucket, else ending in `/`. Every path is
	// resolved under it (hfBucketLocation.ts).
	prefix: string;
	// How Alpha holds access: a token the person pasted (absent means this), or the grant from Connect
	// Hugging Face (CUR-2932), whose sealed credential is a refreshable OAuth grant. jsonb, so no migration.
	grant?: "token" | "oauth";
};

export const storageLocations = pgTable(
	"storage_locations",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// "hf-bucket" today. Drive, Dropbox or an iOS-style per-file grant would each be a kind.
		kind: text("kind").notNull(),
		label: text("label").notNull(),
		config: jsonb("config").$type<StorageLocationConfig>().notNull(),
		credential: text("credential").notNull(),
		// "ok" | "needs-reconnect". Written by the registry when the credential stops opening or the
		// provider answers 401/403/404.
		status: text("status").notNull().default("ok"),
		lastError: text("last_error"),
		verifiedAt: timestamp("verified_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("storage_locations_user_idx").on(t.userId)]
);

export type StorageLocationRow = typeof storageLocations.$inferSelect;

// ── userMcpServers (CUR-4016: an MCP server a person added in Settings → Connectors) ───────────
// One row per server. `credential` is the bearer token they gave, sealed with
// storage/locations/sealedSecret.ts under its own info string, or null when the server needs none. It
// never leaves the server and is sent only to `url`'s own origin (mcp/servers.ts originScopedFetch).
export const userMcpServers = pgTable(
	"user_mcp_servers",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// The `name__` prefix of every tool it contributes; unique per person.
		name: text("name").notNull(),
		url: text("url").notNull(),
		credential: text("credential"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [uniqueIndex("user_mcp_servers_user_name_idx").on(t.userId, t.name)]
);

export type UserMcpServerRow = typeof userMcpServers.$inferSelect;

// One row per account that has chosen where new files go or has uploaded with locations on. No row,
// or a null `default_location`, is "Last used" (CUR-3077); "alpha" is Alpha storage; "ask" asks on
// every upload once a second location is linked; anything else is a storage_locations id.
export const storagePreferences = pgTable("storage_preferences", {
	userId: text("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	defaultLocation: text("default_location"),
	// Where this account's most recent upload went ("alpha" or a storage_locations id), what
	// "Last used" resolves to. Null until the first upload, and cleared when that location is unlinked. (CUR-3077)
	lastUsedLocation: text("last_used_location"),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── upload_chunks (a My files upload too large for one request, waiting to be reassembled) ────
// Vercel refuses a request body over 4.5 MB before our handler runs, so a larger file
// arrives as several chunk requests that may each land on a different instance. They wait here until
// the finishing request reassembles them and runs every upload check on the whole file. Nothing in
// this table has been scanned, so nothing reads it except that request, and the cleanup cron drops
// any upload abandoned for an hour. `owner_id` has no FK on purpose: a guest owner is not a users
// row, and the sweep, not a cascade, is what bounds how long bytes stay. (CUR-1780)
export const uploadChunks = pgTable(
	"upload_chunks",
	{
		ownerId: text("owner_id").notNull(),
		uploadId: text("upload_id").notNull(),
		idx: integer("idx").notNull(),
		data: bytea("data").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		primaryKey({ columns: [t.ownerId, t.uploadId, t.idx] }),
		index("upload_chunks_created_idx").on(t.createdAt),
	]
);

// ── sync_tombstones (deletes a connected sync client mirrors, CUR-4312) ──────────────────────────
// A conversation delete removes the row, so nothing is left for /chat/api/v2/sync/changes to report.
// Each delete made while thunderbolt-sync is on writes one of these instead: the deleted id and the
// client id it was pushed under, if any. Kept 30 days (db/cleanup.ts); a client offline longer than
// that misses the delete and keeps its copy. `kind` is "conversation" or "message".
export const syncTombstones = pgTable(
	"sync_tombstones",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		kind: text("kind").notNull(),
		entityId: text("entity_id").notNull(),
		clientId: text("client_id"),
		// The OAuth client_id that pushed the deleted row, or "alpha"; `clientId` means something only
		// beside it.
		origin: text("origin").notNull().default("alpha"),
		deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("sync_tombstones_user_deleted_idx").on(t.userId, t.deletedAt)]
);
