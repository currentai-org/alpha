import { Address4, Address6 } from "ip-address";
import { isIP } from "node:net";
import dns from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";

const UNSAFE_IPV4_SUBNETS = [
	"0.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.168.0.0/16",
	// Special-use space (CUR-3526): IETF protocol assignments, the benchmarking range some clouds hand
	// out internally, multicast, and the reserved block up to and including broadcast.
	"192.0.0.0/24",
	"198.18.0.0/15",
	"224.0.0.0/4",
	"240.0.0.0/4",
].map((s) => new Address4(s));

// IPv4-mapped IPv6 range (::ffff:0:0/96). `Address6.is4()` does NOT recognize the form a URL parser
// normalizes a mapped literal into (new URL("https://[::ffff:10.0.0.1]").hostname → "::ffff:a00:1"),
// which let mapped loopback/private addresses bypass the guard. Discriminate on the subnet instead,
// then decode the embedded IPv4 with to4() (which DOES handle the normalized hex form).
const MAPPED_V4_SUBNET = new Address6("::ffff:0:0/96");

// Unique local addresses (fc00::/7) are the IPv6 counterpart of the private IPv4 ranges, and
// isLoopback()/isLinkLocal() do not cover them. Unlike 10.0.0.0/8, nothing we run depends on reaching
// one, so the default mode blocks them too (upstream chat-ui 837daec, CUR-2117).
const IPV6_ULA = new Address6("fc00::/7");

/** IPv6 literals arrive from `URL.hostname` bracketed; `isIP` only accepts them bare. */
function stripBrackets(hostname: string): string {
	return hostname.replace(/^\[|]$/g, "");
}

// IPv6 prefixes that carry an IPv4 address inside them (CUR-3526): NAT64 puts it in the last 32 bits,
// 6to4 in the 32 bits after the 2002::/16 prefix. A gateway on either path delivers to that IPv4, so
// it is checked exactly as the mapped form is.
const NAT64_SUBNET = new Address6("64:ff9b::/96");
const SIX_TO_FOUR_SUBNET = new Address6("2002::/16");
const IPV6_MULTICAST = new Address6("ff00::/8");

function v4FromGroups(hi: string, lo: string): Address4 {
	const n = (parseInt(hi, 16) << 16) | parseInt(lo, 16);
	return new Address4([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
}

/** The embedded IPv4 of an IPv4-mapped, NAT64 or 6to4 IPv6 address, or null if `addr` is none. */
function mappedV4(addr: Address6): Address4 | null {
	try {
		if (addr.isInSubnet(MAPPED_V4_SUBNET)) return addr.to4();
		const g = addr.canonicalForm().split(":");
		if (addr.isInSubnet(NAT64_SUBNET)) return v4FromGroups(g[6], g[7]);
		if (addr.isInSubnet(SIX_TO_FOUR_SUBNET)) return v4FromGroups(g[1], g[2]);
		return null;
	} catch {
		return null;
	}
}

function isUnsafeIp(address: string): boolean {
	const family = isIP(address);

	if (family === 4) {
		const addr = new Address4(address);
		return UNSAFE_IPV4_SUBNETS.some((subnet) => addr.isInSubnet(subnet));
	}

	if (family === 6) {
		const addr = new Address6(address);
		const v4 = mappedV4(addr); // e.g. ::ffff:127.0.0.1, 64:ff9b::7f00:1, 2002:7f00:1:: → the embedded IPv4
		if (v4) {
			return UNSAFE_IPV4_SUBNETS.some((subnet) => v4.isInSubnet(subnet));
		}
		// The unspecified address reaches localhost, exactly as 0.0.0.0 does.
		if (addr.correctForm() === "::") return true;
		if (addr.isInSubnet(IPV6_ULA)) return true;
		if (addr.isInSubnet(IPV6_MULTICAST)) return true;
		return addr.isLoopback() || addr.isLinkLocal();
	}

	return true; // Unknown format → block
}

// Stricter blocklist for callers that must NOT reach cluster-internal hosts: adds RFC1918 10/8, which
// the DEFAULT isUnsafeIp intentionally ALLOWS for the cluster's internal load balancers (see
// urlSafety.test.ts "allows 10.0.0.0/8"). Used only by the admin URL-ingest path so an operator can't
// point ingest at an internal service.
const STRICT_EXTRA_IPV4 = [new Address4("10.0.0.0/8")];

function isUnsafeIpStrict(address: string): boolean {
	if (isUnsafeIp(address)) return true;
	const family = isIP(address);
	if (family === 4) {
		const addr = new Address4(address);
		return STRICT_EXTRA_IPV4.some((subnet) => addr.isInSubnet(subnet));
	}
	if (family === 6) {
		const addr = new Address6(address);
		const v4 = mappedV4(addr); // mapped 10.x (default-allowed) must still be blocked here
		if (v4) {
			return STRICT_EXTRA_IPV4.some((subnet) => v4.isInSubnet(subnet));
		}
		return addr.isInSubnet(IPV6_ULA);
	}
	return true;
}

/**
 * Does `hostname` (as `URL.hostname` gives it) name this machine or a private network? True for
 * `localhost` and its subdomains, and for an IP literal in the strict ranges (loopback, RFC1918,
 * link-local, CGNAT, ULA, and the IPv4-mapped form of each). A name that merely RESOLVES to a private
 * address returns false here; `ssrfStrictFetch` catches that at connect time.
 */
export function isPrivateHostname(hostname: string): boolean {
	const host = stripBrackets(hostname.toLowerCase()).replace(/\.$/, "");
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	return isIP(host) ? isUnsafeIpStrict(host) : false;
}

/**
 * Synchronous URL validation: checks protocol and hostname string.
 */
export function isValidUrl(urlString: string): boolean {
	try {
		const url = new URL(urlString.trim());
		if (url.protocol !== "https:") {
			return false;
		}
		const hostname = url.hostname.toLowerCase();
		if (hostname === "localhost") {
			return false;
		}
		// If the hostname is a raw IP literal, validate it
		const cleanHostname = stripBrackets(hostname);
		if (isIP(cleanHostname)) {
			return !isUnsafeIp(cleanHostname);
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Stricter isValidUrl for the admin URL-ingest path: ALSO rejects cluster-internal ranges (RFC1918
 * 10/8 and IPv6 ULA) that the default intentionally permits. Pair with ssrfStrictFetch, which
 * applies the same stricter check to the RESOLVED IP at connection time (DNS-rebinding safe).
 */
export function isValidUrlStrict(urlString: string): boolean {
	if (!isValidUrl(urlString)) return false;
	try {
		const cleanHostname = stripBrackets(new URL(urlString.trim()).hostname.toLowerCase());
		if (isIP(cleanHostname)) return !isUnsafeIpStrict(cleanHostname);
		return true;
	} catch {
		return false;
	}
}

/**
 * Assert that a resolved IP address is safe (not internal/private).
 * Throws if the IP is internal. Used in undici's custom DNS lookup
 * to validate IPs at connection time (prevents TOCTOU DNS rebinding).
 */
export function assertSafeIp(address: string, hostname: string): void {
	if (isUnsafeIp(address)) {
		throw new Error(`Resolved IP for ${hostname} is internal (${address})`);
	}
}

/**
 * Undici agent that validates resolved IPs at connection time,
 * preventing TOCTOU DNS rebinding attacks.
 */
const ssrfSafeAgent = new Agent({
	connect: {
		lookup: (hostname, options, callback) => {
			dns.lookup(hostname, options, (err, address, family) => {
				if (err) return callback(err, "", 4);
				if (typeof address === "string") {
					try {
						assertSafeIp(address, hostname);
					} catch (e) {
						return callback(e as Error, "", 4);
					}
				} else if (Array.isArray(address)) {
					for (const entry of address) {
						try {
							assertSafeIp(entry.address, hostname);
						} catch (e) {
							return callback(e as Error, "", 4);
						}
					}
				}
				return callback(null, address, family);
			});
		},
	},
});

// Stricter agent for the admin URL-ingest path: rejects the cluster-internal ranges at connection
// time too (RFC1918 10/8 + IPv6 ULA), so a hostname that RESOLVES to 10.x can't slip through via DNS.
const ssrfStrictAgent = new Agent({
	connect: {
		lookup: (hostname, options, callback) => {
			dns.lookup(hostname, options, (err, address, family) => {
				if (err) return callback(err, "", 4);
				const ips = typeof address === "string" ? [address] : address.map((a) => a.address);
				for (const ip of ips) {
					if (isUnsafeIpStrict(ip)) {
						return callback(new Error(`Resolved IP for ${hostname} is internal (${ip})`), "", 4);
					}
				}
				return callback(null, address, family);
			});
		},
	},
});

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Reject a URL whose host is an unsafe IP literal before connecting. The agents' `lookup` hook only
 * runs for hosts undici resolves through DNS, so a raw IP literal would otherwise reach the network
 * with no check at all. Today's callers validate first; this keeps the fetch safe on its own
 * (upstream chat-ui 837daec, CUR-2117).
 */
function assertSafeUrlHost(urlString: string, unsafe: (ip: string) => boolean): void {
	const host = stripBrackets(new URL(urlString).hostname.toLowerCase());
	if (isIP(host) && unsafe(host)) {
		throw new Error(`Blocked request to unsafe IP (SSRF): ${host}`);
	}
}

/**
 * Shared SSRF-safe fetch: rejects unsafe IP literals up front (via `unsafe`), validates resolved IPs
 * at connection time (via `agent`) and validates redirect targets (via `validate`) to prevent SSRF
 * through open redirects. `redirect:"manual"` returns redirects as-is (caller validates); otherwise
 * hops are followed with each validated.
 */
async function ssrfFetchImpl(
	url: string | URL,
	init: RequestInit | undefined,
	agent: Agent,
	validate: (u: string) => boolean,
	unsafe: (ip: string) => boolean
): Promise<Response> {
	const callerRedirect = init?.redirect ?? "follow";

	if (callerRedirect === "error") {
		// Honour redirect:"error" — make the request and throw if we get a redirect
		assertSafeUrlHost(url.toString(), unsafe);
		const response = (await undiciFetch(url.toString(), {
			...(init as Record<string, unknown>),
			redirect: "manual",
			dispatcher: agent,
		})) as unknown as Response;
		if (REDIRECT_STATUSES.has(response.status)) {
			throw new TypeError("unexpected redirect");
		}
		return response;
	}

	if (callerRedirect === "manual") {
		// Caller handles redirects — return as-is
		assertSafeUrlHost(url.toString(), unsafe);
		return (await undiciFetch(url.toString(), {
			...(init as Record<string, unknown>),
			redirect: "manual",
			dispatcher: agent,
		})) as unknown as Response;
	}

	// Default: follow redirects with SSRF validation on each hop
	let currentUrl = url.toString();
	let currentInit = init;
	let redirectCount = 0;


	while (true) {
		assertSafeUrlHost(currentUrl, unsafe);
		const response = (await undiciFetch(currentUrl, {
			...(currentInit as Record<string, unknown>),
			redirect: "manual",
			dispatcher: agent,
		})) as unknown as Response;

		if (REDIRECT_STATUSES.has(response.status)) {
			redirectCount++;
			if (redirectCount > MAX_REDIRECTS) {
				throw new Error("Too many redirects");
			}

			const location = response.headers.get("location");
			if (!location) {
				throw new Error("Redirect without Location header");
			}

			const redirectUrl = new URL(location, currentUrl).toString();
			if (!validate(redirectUrl)) {
				throw new Error(`Redirect to unsafe URL blocked (SSRF): ${redirectUrl}`);
			}

			// Per fetch spec: 301/302 rewrite POST→GET; 303 rewrites any non-GET/HEAD→GET
			const method = (currentInit?.method ?? "GET").toUpperCase();
			if (
				([301, 302].includes(response.status) && method === "POST") ||
				(response.status === 303 && method !== "GET" && method !== "HEAD")
			) {
				currentInit = { ...init, method: "GET", body: undefined };
			}

			currentUrl = redirectUrl;
			continue;
		}

		return response;
	}
}

/** Default SSRF-safe fetch (allows cluster-internal 10/8, per isValidUrl). Used by /api/fetch-url. */
export async function ssrfSafeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
	return ssrfFetchImpl(url, init, ssrfSafeAgent, isValidUrl, isUnsafeIp);
}

/** Stricter SSRF-safe fetch for admin URL ingest: also blocks cluster-internal ranges (10/8, ULA),
 *  at connection time and on every redirect hop. */
export async function ssrfStrictFetch(url: string | URL, init?: RequestInit): Promise<Response> {
	return ssrfFetchImpl(url, init, ssrfStrictAgent, isValidUrlStrict, isUnsafeIpStrict);
}
