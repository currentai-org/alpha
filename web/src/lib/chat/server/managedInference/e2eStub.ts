// A stub Pangolin answered inside this deployment, for the `pangolin_stub` fault (CUR-4110). Previews
// have no Pangolin (it is a separate piece of infra, see pangolin/README.md), so without this a spec
// could never provision a managed endpoint there and the pairing link's whole path would go untested
// in CI. Every response has the shape the real Integration API returns (pangolinClient.ts's schemas),
// so provisioning, the pairing handoff and the endpoint row all run unmodified; only the network call
// is skipped. The tunnel credentials it mints open nothing.
import { randomBytes } from "crypto";
import type { PangolinProvisioningClient, ProvisioningDeps } from "./provision";

const STUB_DOMAIN = "pangolin-stub.e2e.invalid";
const STUB_TUNNEL_ENDPOINT = `https://tunnel.${STUB_DOMAIN}`;

let nextId = 1;

const stubPangolin: PangolinProvisioningClient = {
	async pickSiteDefaults() {
		const hex = randomBytes(8).toString("hex");
		return {
			exitNodeId: 1,
			address: "100.89.128.1/24",
			publicKey: "stub-public-key",
			name: "stub-site",
			listenPort: 51820,
			endpoint: STUB_TUNNEL_ENDPOINT,
			subnet: "100.89.128.0/24",
			newtId: `stub-newt-${hex}`,
			newtSecret: `stub-secret-${randomBytes(16).toString("hex")}`,
		};
	},
	async createSite(defaults) {
		return { siteId: nextId++, niceId: defaults.newtId, online: false, type: "newt" };
	},
	async listDomains() {
		return [{ domainId: "stub-domain", baseDomain: STUB_DOMAIN }];
	},
	async createPublicResource(_label, subdomain, domainId) {
		return { resourceId: nextId++, niceId: subdomain, fullDomain: `${subdomain}.${STUB_DOMAIN}`, domainId };
	},
	async createTarget() {},
	async createResourceAccessToken() {
		return { accessTokenId: `stub-token-${nextId++}`, accessToken: randomBytes(16).toString("hex") };
	},
};

export const stubProvisioningDeps: ProvisioningDeps = {
	pangolin: stubPangolin,
	tunnelEndpoint: STUB_TUNNEL_ENDPOINT,
};
