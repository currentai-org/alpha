/**
 * Provision a new "managed" local inference endpoint — a device behind a firewall/NAT,
 * reached through Pangolin's reverse tunnel instead of a public URL the user types themselves. See
 * `pangolinClient.ts` for the API calls made here.
 *
 * Orchestrates: pick-site-defaults -> create site (the future newt device) -> pick a domain ->
 * create a public HTTP resource under it -> bind a target at that site's local llama.cpp port ->
 * mint a resource access token (every public resource is SSO-gated by default; this is the
 * non-interactive credential Pangolin itself supports instead, see pangolinClient.ts) -> persist
 * one `local_inference_endpoints` row (`kind: "managed"`, the access token stored in the row's
 * existing `headers` column so it rides the same CUR-1266 request-header pipeline every other
 * local endpoint already uses) -> return the install flags `aipotluck-local-client`'s installer
 * takes directly (`--tunnel-id/--tunnel-secret/--tunnel-endpoint`).
 * (CUR-1266)
 * Shared by the two ways to pair — the settings page's Pair button
 * (api/v2/user/local-inference-endpoints/managed), which shows the install flags once, and the
 * CLI's pairing link (chat/local-inference/pair), which parks them for the CLI to collect once.
 * Callers gate on `managedInferenceEnabled()` and authenticate the user first; this just provisions. (CUR-4110)
 */
import { randomBytes } from "crypto";
import { error } from "@sveltejs/kit";
import { pangolinDomainId, pangolinTunnelEndpoint } from "$lib/chat/server/managedInferenceGate";
import * as pangolinClient from "$lib/chat/server/managedInference/pangolinClient";
import {
	createLocalEndpoint,
	type LocalInferenceEndpointRow,
	type LocalInferenceHeader,
} from "$lib/chat/server/db/localInferenceEndpoints";

// The port aipotluck-local-client's llama-server listens on by default (installer/install.py's
// DEFAULT_SERVER_PORT) -- fixed rather than user-entered, since a managed endpoint has no URL field.
const MANAGED_TARGET_PORT = 8080;

// Pangolin's own default header names for a resource access token (`server.
// resource_access_token_headers` in the operator's config.yml, confirmed against `verifySession.ts`
// server-side) — hardcoded here since this app only ever talks to Pangolin over its REST API, never
// reads its config file directly. If a deployment ever overrides these in its own Pangolin
// config.yml, this constant needs to change to match.
const ACCESS_TOKEN_ID_HEADER = "P-Access-Token-Id";
const ACCESS_TOKEN_HEADER = "P-Access-Token";

/** The Pangolin calls provisioning makes — the real client by default; the `pangolin_stub` fault
 *  (managedInference/e2eStub.ts) swaps in one answered inside the process. */
export type PangolinProvisioningClient = Pick<
	typeof pangolinClient,
	"pickSiteDefaults" | "createSite" | "listDomains" | "createPublicResource" | "createTarget" | "createResourceAccessToken"
>;

/** What `aipotluck-local-client login` takes. `tunnelSecret` is a plain string here: each route that
 *  sends it marks it with `discloseToOwner` and says why the recipient is its owner. */
export type ManagedInstallArgs = {
	tunnelId: string;
	tunnelSecret: string;
	tunnelEndpoint: string;
};

function slugify(label: string): string {
	const base = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	const suffix = randomBytes(3).toString("hex");
	return `${base || "device"}-${suffix}`;
}

export type ProvisioningDeps = {
	pangolin: PangolinProvisioningClient;
	/** What the CLI dials (`--tunnel-endpoint`). */
	tunnelEndpoint: string;
};

const realDeps = (): ProvisioningDeps => ({ pangolin: pangolinClient, tunnelEndpoint: pangolinTunnelEndpoint() });

export async function provisionManagedEndpoint(
	input: { userId: string; label: string; headers?: LocalInferenceHeader[] },
	deps: ProvisioningDeps = realDeps()
): Promise<{ row: LocalInferenceEndpointRow; installArgs: ManagedInstallArgs }> {
	const { pangolin } = deps;
	const { userId, label } = input;

	const defaults = await pangolin.pickSiteDefaults();
	// Pangolin's site "Name" is shared, org-wide dashboard state -- prefixing it with the owning
	// userId keeps two users' "Workstation" sites distinguishable there, without changing anything
	// this app itself reads (our own `label` on the persisted row stays exactly what the user typed).
	const site = await pangolin.createSite(defaults, `${userId}: ${label}`);

	const configuredDomainId = pangolinDomainId();
	const domains = await pangolin.listDomains();
	const domain = domains.find((d) => d.domainId === configuredDomainId) ?? domains[0];
	if (!domain) error(500, "No Pangolin domain configured — see pangolin/README.md");

	const subdomain = slugify(label);
	const resource = await pangolin.createPublicResource(label, subdomain, domain.domainId);
	await pangolin.createTarget(resource.resourceId, site.siteId, MANAGED_TARGET_PORT);
	const accessToken = await pangolin.createResourceAccessToken(resource.resourceId);

	const row = await createLocalEndpoint({
		userId,
		label,
		// Pangolin forces `ssl: true` server-side on every public HTTP resource (confirmed by reading
		// createResource.ts directly — not something the create-resource request body can override),
		// so this is always https:// regardless of how the tunnel endpoint itself is reached.
		baseUrl: `https://${resource.fullDomain}/v1`,
		kind: "managed",
		managedConfig: {
			provider: "pangolin",
			siteId: site.siteId,
			niceId: site.niceId,
			resourceId: String(resource.resourceId),
		},
		// The resource is SSO-gated by default; the access-token pair is what lets our own
		// server-to-server requests (discovery, prewarm, generation — see localModels.ts's
		// headersRecord()) through without a Pangolin login session, applied via the same
		// per-endpoint header pipeline CUR-1266 built.
		//
		// The user's own headers go FIRST and the access token LAST, deliberately: headersRecord()
		// builds the record with Object.fromEntries, where a later entry wins, so this ordering means
		// a custom header named P-Access-Token cannot displace the real one and silently cut the
		// tunnel off from the server it is meant to reach.
		headers: [
			...(input.headers ?? []),
			{ name: ACCESS_TOKEN_ID_HEADER, value: accessToken.accessTokenId },
			{ name: ACCESS_TOKEN_HEADER, value: accessToken.accessToken },
		],
	});

	return {
		row,
		installArgs: {
			tunnelId: defaults.newtId,
			tunnelSecret: defaults.newtSecret,
			tunnelEndpoint: deps.tunnelEndpoint,
		},
	};
}
