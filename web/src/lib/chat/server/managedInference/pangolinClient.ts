/**
 * Thin wrapper around Pangolin's Integration API (CUR-1266) — the reverse-tunnel control plane
 * behind "managed" local-inference endpoints. Every field name below was confirmed directly against
 * `fosrl/pangolin`'s server source, since its OpenAPI docs type response
 * shapes loosely (`additionalProperties: nullable`) — see `server/routers/site/*.ts`,
 * `server/routers/resource/createResource.ts`, `server/routers/target/createTarget.ts`, and the
 * `sites`/`resources`/`targets` Drizzle tables in `server/db/pg/schema/schema.ts`.
 *
 * Auth: a single Bearer org-scoped Integration API token (`pangolinIntegrationToken()`), same
 * pattern as `agentServiceToken()` — never per-user, never per-device.
 *
 * IMPORTANT: never create a public resource with `mode: "inference"` — that's Pangolin's own
 * separate built-in AI-gateway/billing feature (a provider/model catalog + budgets + virtual API
 * keys), confirmed by reading `server/lib/aiInferenceResource.ts`. Always `mode: "http"` — Pangolin
 * is purely the network tunnel here; all AI-specific routing stays in this app's own
 * `endpointOai.ts`. See `pangolin/README.md`'s "Known gotchas" section.
 */
import { z } from "zod";
import {
	pangolinApiUrl,
	pangolinIntegrationToken,
	pangolinOrgId,
} from "$lib/chat/server/managedInferenceGate";

export class PangolinApiError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = "PangolinApiError";
	}
}

async function callApi<T>(
	method: "GET" | "PUT" | "POST" | "DELETE",
	path: string,
	schema: z.ZodType<T>,
	body?: unknown
): Promise<T> {
	// The Integration API is mounted under /v1 (confirmed live: /v1/openapi.json, /v1/org/{orgId}/...)
	// — PANGOLIN_API_URL itself is just the bare host:port, so every call site's path is relative to
	// /v1, never the bare host. Hardcoded here rather than requiring callers to remember it.
	const base = `${pangolinApiUrl()}/v1`;
	const response = await fetch(`${base}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${pangolinIntegrationToken()}`,
			...(body ? { "content-type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(10_000),
	});

	const json = await response.json().catch(() => null);
	if (!response.ok) {
		const message =
			(json && typeof json === "object" && "message" in json && String(json.message)) ||
			`Pangolin API ${method} ${path} failed: ${response.status}`;
		throw new PangolinApiError(message, response.status);
	}

	// Every Integration API response is `{data, success, error, message, status}` — unwrap `data`
	// and validate it against the caller's schema, rather than trusting the wire shape blindly.
	const envelope = z.object({ data: schema }).parse(json);
	return envelope.data;
}

// ── pick-site-defaults ───────────────────────────────────────────────────────────────────────────
// GET /org/{orgId}/pick-site-defaults — server/routers/site/pickSiteDefaults.ts's response.
const pickSiteDefaultsSchema = z.object({
	exitNodeId: z.number(),
	address: z.string(),
	publicKey: z.string(),
	name: z.string(),
	listenPort: z.number(),
	endpoint: z.string(),
	subnet: z.string(),
	newtId: z.string(),
	newtSecret: z.string(),
	clientAddress: z.string().optional(),
});
export type PangolinSiteDefaults = z.infer<typeof pickSiteDefaultsSchema>;

export async function pickSiteDefaults(): Promise<PangolinSiteDefaults> {
	return callApi("GET", `/org/${pangolinOrgId()}/pick-site-defaults`, pickSiteDefaultsSchema);
}

// ── create site ───────────────────────────────────────────────────────────────────────────────────
// PUT /org/{orgId}/site — server/routers/site/createSite.ts spreads the `sites` table row plus
// `newtId`/`secret` for type "newt". `.passthrough()` since the real row has many more columns
// (megabytesIn, dockerSocketEnabled, ...) this app never reads.
const siteSchema = z
	.object({
		siteId: z.number(),
		niceId: z.string(),
		online: z.boolean(),
		type: z.string(),
	})
	.passthrough();
export type PangolinSite = z.infer<typeof siteSchema>;

export async function createSite(defaults: PangolinSiteDefaults, label: string): Promise<PangolinSite> {
	return callApi("PUT", `/org/${pangolinOrgId()}/site`, siteSchema, {
		name: label,
		type: "newt",
		exitNodeId: defaults.exitNodeId,
		niceId: defaults.newtId,
		pubKey: defaults.publicKey,
		subnet: defaults.subnet,
		newtId: defaults.newtId,
		secret: defaults.newtSecret,
		address: defaults.clientAddress ?? defaults.address,
	});
}

// ── domains ───────────────────────────────────────────────────────────────────────────────────────
// GET /org/{orgId}/domains
const domainsSchema = z.object({
	domains: z.array(z.object({ domainId: z.string(), baseDomain: z.string() }).passthrough()),
});

export async function listDomains(): Promise<{ domainId: string; baseDomain: string }[]> {
	const result = await callApi("GET", `/org/${pangolinOrgId()}/domains`, domainsSchema);
	return result.domains;
}

// ── create public resource ──────────────────────────────────────────────────────────────────────
// PUT /org/{orgId}/public-resource — server/routers/resource/createResource.ts spreads the
// `resources` table row (`resourceId`, `niceId`, `fullDomain`, `domainId`, `ssl`, ...).
const publicResourceSchema = z
	.object({
		resourceId: z.number(),
		niceId: z.string(),
		fullDomain: z.string(),
		domainId: z.string().nullable(),
	})
	.passthrough();
export type PangolinPublicResource = z.infer<typeof publicResourceSchema>;

export async function createPublicResource(
	label: string,
	subdomain: string,
	domainId: string
): Promise<PangolinPublicResource> {
	return callApi("PUT", `/org/${pangolinOrgId()}/public-resource`, publicResourceSchema, {
		name: label,
		subdomain,
		domainId,
		mode: "http", // NEVER "inference" — see module doc comment.
	});
}

// ── create target ────────────────────────────────────────────────────────────────────────────────
// PUT /public-resource/{resourceId}/target — server/routers/target/createTarget.ts spreads the
// `targets` table row (`targetId`, `resourceId`, `siteId`, `ip`, `port`, `mode`).
const targetSchema = z.object({ targetId: z.number() }).passthrough();

export async function createTarget(
	resourceId: number,
	siteId: number,
	port: number
): Promise<void> {
	await callApi("PUT", `/public-resource/${resourceId}/target`, targetSchema, {
		siteId,
		ip: "localhost",
		port,
		mode: "http",
		method: "http",
		enabled: true,
	});
}

// ── resource access token ────────────────────────────────────────────────────────────────────────
// POST /public-resource/{resourceId}/access-token — server/routers/accessToken/generateAccessToken.ts.
// Every public resource is SSO-gated by default (`sso: true` hardcoded on its default policy,
// confirmed in createResource.ts) — this mints the one non-interactive credential Pangolin itself
// supports for a resource, checked by the badger auth plugin against two headers
// (`server.resource_access_token_headers`, default `P-Access-Token-Id`/`P-Access-Token`, confirmed
// in verifySession.ts). No `validForSeconds` given → never expires, matching how the newt
// secret/tunnel credential is already stored permanently. These two headers get stored in the
// row's EXISTING `headers` jsonb column (CUR-1266) — no new plumbing needed on the request path,
// since `headersRecord()`/`defaultHeaders` already apply whatever's there to every request
// (discovery, prewarm, generation).
const accessTokenSchema = z.object({ accessTokenId: z.string(), accessToken: z.string() }).passthrough();

export async function createResourceAccessToken(
	resourceId: number
): Promise<{ accessTokenId: string; accessToken: string }> {
	return callApi("POST", `/public-resource/${resourceId}/access-token`, accessTokenSchema, {});
}

// ── site status ───────────────────────────────────────────────────────────────────────────────────
// GET /org/{orgId}/site/{niceId} — server/routers/site/getSite.ts spreads the `sites` row (which
// carries `online: boolean`) plus newt-specific fields this app doesn't need.
const siteStatusSchema = z.object({ online: z.boolean() }).passthrough();

export async function getSiteStatus(niceId: string): Promise<{ online: boolean }> {
	return callApi("GET", `/org/${pangolinOrgId()}/site/${niceId}`, siteStatusSchema);
}

// ── revoke ────────────────────────────────────────────────────────────────────────────────────────
// DELETE /site/{siteId} and DELETE /public-resource/{resourceId} — both confirmed real endpoints
// in the live OpenAPI spec. Best-effort: callers should log and continue on failure (see the
// managed-endpoint DELETE route), never block removing our own DB row on the tunnel side
// succeeding — same fail-soft posture as `prewarmLocalModel`.
export async function deleteSite(siteId: number): Promise<void> {
	await callApi("DELETE", `/site/${siteId}`, z.unknown());
}

export async function deletePublicResource(resourceId: number): Promise<void> {
	await callApi("DELETE", `/public-resource/${resourceId}`, z.unknown());
}
