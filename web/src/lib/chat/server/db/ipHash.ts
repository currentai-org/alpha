import { createHmac } from "crypto";
import { Address4, Address6 } from "ip-address";
import { config } from "$lib/chat/server/config";

// Pseudonymise a client IP before it is ever persisted (the "Get involved" per-IP daily cap AND the
// per-IP rate-limit events). We NEVER persist a raw IP: an IP is personal data (GDPR Art. 4 / EDPB),
// so the stored value is designed to reveal nothing at rest even to someone holding the database.
//
// HMAC-SHA256 keyed by a server-side secret pepper (CONTRIBUTION_IP_PEPPER — one secret peppers all
// client-IP hashing app-wide):
//   • non-reversible — you cannot read an IP back out of the hash;
//   • non-correlatable without the secret — the IPv4 space is only 2^32, small enough that a
//     PLAIN (unkeyed) hash is brute-forceable in minutes, so the secret key is what actually
//     protects it. Rotating the pepper invalidates all stored hashes, by design;
//   • stable — the same IP maps to the same hash, so a daily COUNT still groups a repeat
//     submitter without ever knowing who they are.
//
// DOMAIN SEPARATION: the `domain` label is folded into the HMAC input so the SAME IP yields a
// DIFFERENT hash per use-site ("contribution" vs "rate-limit"). This stops anyone with DB read
// access from joining an identified contribution row (it carries email/name) to that person's
// chat rate-limit events by matching equal IP hashes — a real (if minor) deanonymisation vector
// that one shared hash would open. One secret, per-purpose outputs.
//
// FAIL TOWARD PRIVACY: with no pepper configured we return null rather than store a weakly-keyed
// (brute-forceable) hash. That degrades the per-IP cap to a no-op — which already fails OPEN by
// design (see /api/contribute and the rate-limiter) — and is the correct trade for an org that
// ranks privacy over abuse-friction. Set CONTRIBUTION_IP_PEPPER to 32+ random bytes in any deploy
// that wants the caps enforced. (Read via Reflect.get so it needs no entry in the committed .env,
// mirroring the other deploy-only knobs like SEARCH_MARGIN_THRESHOLD.)
let warnedNoPepper = false;

// Shared core: same secret pepper, same domain-separation scheme, for any identifier this app needs
// to pseudonymize before it touches disk — not just an IP. `hashIp` below is the IP-specific, back-
// compat-named entry point; `hashTargetEmail` is the other current caller.
function peppered(raw: string, domain: string): string | null {
	if (!raw) return null;
	const pepper = (
		(Reflect.get(config, "CONTRIBUTION_IP_PEPPER") as string | undefined) ?? ""
	).trim();
	if (!pepper) {
		if (!warnedNoPepper) {
			console.warn(
				"[ip-hash] CONTRIBUTION_IP_PEPPER unset — per-identifier caps DISABLED (no hash stored)"
			);
			warnedNoPepper = true;
		}
		return null;
	}
	// `domain:` prefix is the separator. This does NOT rely on ":" being absent from `raw` (IPv6
	// literals and email local-parts can both contain one) — it relies on `domain` being one of a
	// FIXED, hardcoded set of literals below, none of which is a prefix of another up to its own
	// trailing ":". Two different domains can only ever produce the same HMAC input string if one
	// domain literal plus ":" is itself a prefix of another domain literal's own name — check that
	// property (not "no colons in raw") before adding a new domain to any of the unions below.
	return createHmac("sha256", pepper).update(`${domain}:${raw}`).digest("base64url");
}

/** The prefix one IPv6 subscriber is handed: a home or phone gets a /56 to /64 and picks addresses
 *  inside it at will, so keying on the full address lets one network mint a fresh key per request.
 *  /56 is express-rate-limit's default (`ipKeyGenerator`), the same call for the same reason. */
const IPV6_SUBNET_BITS = 56;

/** What a per-network limit counts: an IPv4 address as itself, an IPv6 address as its /56, and an
 *  IPv4-mapped IPv6 address (`::ffff:203.0.113.7`) as the IPv4 it carries. Anything unparseable is
 *  returned trimmed, so it still keys on something rather than everyone sharing an empty key. */
function networkOf(ip: string): string {
	const raw = ip.trim();
	if (Address4.isValid(raw)) return new Address4(raw).correctForm();
	if (!Address6.isValid(raw)) return raw;
	const v6 = new Address6(raw);
	if (v6.is4()) return v6.to4().correctForm();
	return new Address6(`${v6.correctForm()}/${IPV6_SUBNET_BITS}`).networkForm();
}

export function hashIp(
	ip: string | null | undefined,
	domain: "contribution" | "rate-limit" | "admin-audit" | "otp-source" = "contribution"
): string | null {
	const raw = (ip ?? "").trim();
	return peppered(raw && networkOf(raw), domain);
}

// Same secret-peppered, domain-separated HMAC as hashIp (CUR-920), but for a target email
// address. An email is a stronger direct identifier than an IP (which is why hashIp exists at all —
// see the header comment above), so targetEmailRate.ts must never persist the raw address either.
export function hashTargetEmail(email: string): string | null {
	return peppered(email.trim().toLowerCase(), "target-email-rate");
}
