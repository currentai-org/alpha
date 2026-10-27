import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema";

// The stores OUTSIDE Postgres, stubbed so the wipe can run with no network and no database. Each stub
// records that it was reached; the "stores outside Postgres" block below asserts every declared store was.
const { wipeCustodialFiles, deleteAgentServiceData } = vi.hoisted(() => ({
	wipeCustodialFiles: vi.fn(async (_uid: string) => 3),
	deleteAgentServiceData: vi.fn(async (_visitor: string | undefined) => 2),
}));
vi.mock("$lib/chat/server/storage/custodialStorage", () => ({ wipeCustodialFiles }));
vi.mock("$lib/chat/server/deleteAgentServiceData", () => ({ deleteAgentServiceData }));
vi.mock("./deleteConversations", () => ({ deleteConversationsCascade: vi.fn(async () => 0) }));
// A query builder that accepts any chain and resolves to no rows: enough to run wipeUserData's
// control flow end to end without a database. What each DELETE matches is wipeUserData.spec.ts's job.
vi.mock("./client", () => {
	const chain: unknown = new Proxy(function () {}, {
		get: (_t, prop) =>
			prop === "then" ? (done: (v: unknown[]) => void) => done([]) : () => chain,
		apply: () => chain,
	});
	return { getDb: () => chain, withTransaction: <T>(fn: () => Promise<T>) => fn() };
});
import { wipeUserData } from "./wipeUserData";

// COMPLETENESS GATE for the GDPR wipe.
//
// The trash-all flow tells the user, in a panel that itemises what was cleared, that we deleted
// everything we hold about them (Art. 17). That is a CLAIM about the whole schema, and nothing checked
// it. Add a table with a userId/sessionId/ipHash column, forget to wipe it, and the claim quietly
// becomes false while every existing test stays green — the failure is a GAP, and no example test lives
// in a gap.
//
// So this reconciles two lists that must agree: every user-scoped table in the schema, and the tables
// wipeUserData is DECLARED to handle. Same shape as env-audit (manifest vs code) and
// check-orphan-tests (files vs vitest projects) — the third instance of the pattern in this repo.
//
// It deliberately does NOT execute the wipe or touch a database: it is a structural check, hermetic, and
// runs in the ordinary fast suite. It cannot tell you the DELETE is correct — wipeUserData.spec.ts does
// that — only that no table was forgotten entirely.
//
// ── Adding a table ────────────────────────────────────────────────────────────────────────────────
// If it has a user-identifying column you MUST add it below with a verdict. "wiped" means wipeUserData
// deletes or detaches it. "exempt" needs a real reason — a lawful basis or a structural one, not "we
// don't need to". An unlisted table fails this test, on purpose: silence is not consent here.

type Verdict = "wiped" | "exempt";

const COVERAGE: Record<string, { verdict: Verdict; why: string }> = {
	conversations: { verdict: "wiped", why: "deleteConversationsCascade — the primary user content." },
	files: { verdict: "wiped", why: "Cascaded with its conversation (FK-ordered before it)." },
	settings: { verdict: "wiped", why: "Deleted directly by session/user key." },
	sessions: { verdict: "wiped", why: "Deleted by sessionId — ends the session as part of the wipe." },
	message_events: {
		verdict: "wiped",
		why: "Analytics keyed by HMAC ipHash — deleted directly.",
	},
	contributions: {
		verdict: "wiped",
		why: "Get-Involved submissions keyed by HMAC ipHash — deleted directly.",
	},
	reports: {
		verdict: "exempt",
		why: "RETAINED under Art. 17(3) — safety reports survive erasure. deleteConversationsCascade DETACHES them (nulls conversationId) rather than deleting, and the reassurance panel discloses how many were kept and why. Deliberate carve-out, agreed with the trust-and-safety lead.",
	},
	safety_events: {
		verdict: "wiped",
		why: "Every decline record keyed to the caller is deleted EXCEPT kind = 'child_safety', which is retained: same Art. 17(3) basis as reports, and the source for the fail-closed decline-rate probe (the 2026-07-06 incident was reconstructed from it). Until the MozFest walk the whole table was exempt, so a privacy decline (label chat-block-privacy) outlived the account it described.",
	},
	users: {
		verdict: "wiped",
		why: "CUR-434: the exemption above expired the day this table got real rows — Better Auth sign-in creates them now. wipeUserData deletes the shadow row by _id, plus the linked Better Auth account/passkey/session/user rows read off its betterAuthUserId.",
	},
	token_caches: {
		verdict: "wiped",
		why: "CUR-434 revisit: keyed by the raw Hugging Face user id (users.hfUserId), NOT by uid/_id — confirmed against auth.ts's own tokenCaches.insertOne call rather than assumed. wipeUserData reads hfUserId off the users row before deleting it.",
	},
	account: {
		verdict: "wiped",
		why: "CUR-434: Better Auth's own linked-provider rows (OAuth tokens included) — deleted by wipeUserData via the shadow row's stored betterAuthUserId before the users row itself is deleted.",
	},
	passkey: {
		verdict: "wiped",
		why: "CUR-434: WebAuthn credentials. The passkey plugin declares no onDelete cascade on userId (unlike account/session), so wipeUserData deletes these explicitly rather than relying on the FK.",
	},
	session: {
		verdict: "wiped",
		why: "CUR-434: Better Auth's OWN session table (singular — distinct from the guest doc-store `sessions` table above, already wiped). Deleted by wipeUserData via the linked betterAuthUserId.",
	},
	user: {
		verdict: "wiped",
		why: "CUR-434: Better Auth's OWN identity table (singular — distinct from the shadow `users` doc-store table above). Holds the most identifying fields of any table here (name, email). Deleted by wipeUserData via the linked betterAuthUserId, same call as account/passkey/session.",
	},
	verification: {
		verdict: "exempt",
		why: "CUR-434: holds an email in `identifier` during the passkey/email-OTP sign-in flow, but self-expires (expiresAt, default 5 min per the emailOTP plugin) — same TTL-cleanup posture as sessions/message_events' own expiry columns, not a durable record an erasure request needs to reach. Not tied to a specific account either: rows exist for in-progress sign-ins, some of which never complete.",
	},
	admin_audit: {
		verdict: "exempt",
		why: "Accountability log of ADMIN actions, keyed by an operator ipHash rather than an end user's. Erasing it on a visitor's request would let a wipe delete records of staff activity that never concerned them — and an audit log a subject can clear is not an audit log. Surfaced by this gate on its first run, 2026-07-23.",
	},
	generations: {
		verdict: "exempt",
		why: "In-flight generation bookkeeping keyed to a conversation, not durable user content; rows are short-lived and GC'd by the retention cleanup.",
	},
	aborted_generations: {
		verdict: "exempt",
		why: "Transient abort signalling keyed to a conversation; GC'd by the retention cleanup.",
	},
	mcp_elicitations: {
		verdict: "exempt",
		why: "CUR-1017: a parked MCP elicitation, keyed to a conversation. Unlike aborted_generations it can hold real content (the user's own form answer), so deleteConversationsCascade deletes it outright alongside files/generations rather than leaving it to the TTL sweep — the sweep (24h) is a backstop for an unresolved or orphaned row, not the primary mechanism.",
	},
	member: {
		verdict: "wiped",
		why: "CUR-550: workspace membership. onDelete: cascade on userId (schema.ts) — deleting the Better Auth `user` row as part of an account wipe removes every workspace membership row with it, same mechanism as `files` cascading with its conversation.",
	},
	local_inference_endpoints: {
		verdict: "wiped",
		why: "CUR-1194: a user's own LAN/self-hosted inference server config. Keyed on userId (not email, since 2026-09-15 — see schema.ts's header comment on this table) with an onDelete-cascade FK to the shadow users row, but also deleted explicitly by wipeUserData for an accurate WipeSummary count, same reasoning as account/passkey/session below.",
	},
	human_eval_profiles: {
		verdict: "wiped",
		why: "A2 / CUR-1914: a person's declared language level and consent for human evaluation. Deleted explicitly by wipeUserData (step 2c), and the FK to users cascades as a backstop.",
	},
	human_eval_ratings: {
		verdict: "wiped",
		why: "A2 / CUR-1914: ratings a person gave to stored model answers. Deleted, not detached, by wipeUserData (step 2c): results are aggregates recomputed from the remaining ratings.",
	},
	storage_locations: {
		verdict: "wiped",
		why: "CUR-2930: buckets a person linked as their own storage, with our sealed copy of each token. Cascades from users, and deleted explicitly by wipeUserData for the WipeSummary count. The files in their own bucket are not ours and are not deleted.",
	},
	storage_preferences: {
		verdict: "wiped",
		why: "CUR-2930: where new files go by default. Cascades from users, and deleted explicitly by wipeUserData beside storage_locations.",
	},
	local_inference_pairings: {
		verdict: "wiped",
		why: "CUR-4110: the CLI pairing handoff, holding a tunnel secret until the CLI collects it. Cascades from users and from its endpoint, and deleted explicitly by wipeUserData (step 2b').",
	},
	user_mcp_servers: {
		verdict: "wiped",
		why: "CUR-4016: MCP servers a person added in Settings → Connectors, with our sealed copy of each bearer token. Cascades from users, and deleted explicitly by wipeUserData (step 2d).",
	},
	oauth_client: {
		verdict: "wiped",
		why: "CUR-4312: an OAuth client a person registered. Nobody can (clientPrivileges refuses every create in betterAuth.ts), so the seeded Thunderbolt client has no user_id; any that did is deleted by wipeUserData's account step and cascades from `user`.",
	},
	oauth_access_token: {
		verdict: "wiped",
		why: "CUR-4312: sync access tokens a person granted Thunderbolt. Deleted by wipeUserData's account step via betterAuthUserId, and cascades from `user`.",
	},
	oauth_refresh_token: {
		verdict: "wiped",
		why: "CUR-4312: the refresh tokens beside them. Same account step, same cascade.",
	},
	oauth_consent: {
		verdict: "wiped",
		why: "CUR-4312: the record that a person allowed Thunderbolt. Same account step, same cascade. A data-only wipe keeps the connection, the way it keeps the account it hangs off (CUR-1420).",
	},
	sync_tombstones: {
		verdict: "wiped",
		why: "CUR-4312: ids of conversations and messages a person deleted, for a connected Thunderbolt to mirror. Deleted by wipeUserData (step 2e) and cascades from the shadow users row.",
	},
	invitation: {
		verdict: "wiped",
		why: "CUR-550: holds the invitee's email and the inviter's id. onDelete: cascade on inviterId (schema.ts, this app's own choice — Better Auth's plugin schema declares no cascade here) removes a sent invitation when the SENDER'S account is wiped. The recipient-side case (an invitation addressed to an email that later gets wiped) isn't FK-reachable — email is a plain string here, not a join — but self-expires (Better Auth's default 48h invitationExpiresIn), same TTL posture as the `verification` exemption above.",
	},
};

/** Column names that make a table user-scoped. ipHash counts: it is pseudonymous, not anonymous, so
 *  Art. 17 still reaches it — that is exactly why message_events and contributions are wiped. */
const USER_KEY = /^(userId|sessionId|ipHash)$/;

function userScopedTables(): string[] {
	const found: string[] = [];
	for (const value of Object.values(schema)) {
		if (!is(value, PgTable)) continue;
		const cols = Object.keys(getTableColumns(value));
		// `users` is the definitional case and the heuristic misses it: its own primary key is `id`,
		// not `userId`. Named explicitly rather than loosening the regex, which would drag in every
		// table with an `id` column.
		//
		// `user` (Better Auth's own, CUR-434) has the identical blind spot for the identical reason —
		// its PK is also `id`, and it holds the most identifying fields of all (name, email) — so it
		// gets the same explicit carve-out.
		// `verification` (CUR-434) holds an email in `identifier` during the passkey/email-OTP sign-in
		// flow — the same blind spot again (no userId/sessionId column; its subject is the row's OWN
		// `identifier`, not a foreign key). Named explicitly for the same reason as user/users above.
		//
		// `invitation` (CUR-550) is the identical shape once more: it holds the invitee's email as its
		// OWN `email` column, not a foreign-keyed userId — the invitee may not even have a `user` row
		// yet. Named explicitly rather than widening USER_KEY, which would drag in every table with a
		// plain `email` column regardless of whether it identifies a person (e.g. `contributions`,
		// already wiped by ipHash, doesn't need email in the regex to be caught).
		const name = getTableName(value);
		const scoped =
			name === "users" ||
			name === "user" ||
			name === "verification" ||
			name === "invitation" ||
			cols.some((c) => USER_KEY.test(c)) ||
			cols.includes("conversationId");
		if (scoped) found.push(name);
	}
	return found.sort();
}

describe("GDPR wipe coverage", () => {
	// THE load-bearing assertion. A new user-scoped table with no verdict fails here rather than
	// silently escaping the wipe while we tell the user their data is gone.
	it("every user-scoped table has an explicit wiped/exempt verdict", () => {
		const undeclared = userScopedTables().filter((t) => !COVERAGE[t]);
		expect(
			undeclared,
			`These tables hold user-identifying columns but are not declared in COVERAGE. Either wipeUserData must handle them, or add an exemption with a real reason (see the header).`
		).toEqual([]);
	});

	// Keeps the registry honest in the other direction: a stale entry for a dropped or renamed table is
	// a comment claiming coverage that no longer exists.
	it("declares no table that is no longer user-scoped", () => {
		const scoped = new Set(userScopedTables());
		const stale = Object.keys(COVERAGE).filter((t) => !scoped.has(t));
		expect(stale, "stale COVERAGE entries — table dropped, renamed, or no longer user-keyed").toEqual(
			[]
		);
	});

	it("every exemption states a reason", () => {
		const unjustified = Object.entries(COVERAGE)
			.filter(([, v]) => v.verdict === "exempt" && v.why.trim().length < 40)
			.map(([t]) => t);
		expect(unjustified, "an exemption without a real reason is just a silent gap").toEqual([]);
	});
});

// ── Stores outside Postgres ───────────────────────────────────────────────────────────────────────
// The table check above only sees our own schema. The account's data also lives in two stores it
// cannot see: uploaded files in the custodial HF bucket, and agent-mode history in agent-service. The
// bucket is easy to miss: an uploaded file would survive account deletion. So each
// external store is declared here with the WipeSummary field that reports it, and the wipe is RUN
// against stubs to prove it reaches each one.

const EXTERNAL_STORES: Record<string, { summaryField: string; stub: ReturnType<typeof vi.fn> }> = {
	"custodial bucket (users/<id>/ on HF)": { summaryField: "custodialFiles", stub: wipeCustodialFiles },
	"agent-service task store": { summaryField: "agentServiceTasksDeleted", stub: deleteAgentServiceData },
};

/** Modules under src/ that import the HF hub SDK, which is how this app writes to a bucket. */
function hfSdkImporters(): string[] {
	const webRoot = resolve(__dirname, "../../../../..");
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (/\.(ts|js)$/.test(name) && !/\.(spec|test)\./.test(name)) {
				if (/from\s+["']@huggingface\/hub["']/.test(readFileSync(p, "utf8"))) {
					found.push(relative(webRoot, p));
				}
			}
		}
	};
	walk(join(webRoot, "src"));
	return found.sort();
}

describe("GDPR wipe coverage — stores outside Postgres", () => {
	it("an account wipe reaches every declared external store, and the summary reports each one", async () => {
		const summary = (await wipeUserData({ userId: "acct123", sessionId: "sess123", deleteAccount: true })) as unknown as Record<
			string,
			unknown
		>;
		for (const [store, { summaryField, stub }] of Object.entries(EXTERNAL_STORES)) {
			expect(stub, `${store} was never called by wipeUserData`).toHaveBeenCalled();
			expect(summary[summaryField], `${store}: WipeSummary.${summaryField} not reported`).toBeTypeOf("number");
		}
		expect(wipeCustodialFiles).toHaveBeenCalledWith("acct123", expect.objectContaining({ keepAccount: false }));
	});

	it("Forget everything asks the bucket wipe to keep the account's key usable (CUR-4415)", async () => {
		wipeCustodialFiles.mockClear();
		await wipeUserData({ userId: "acct123", sessionId: "sess123" });
		expect(wipeCustodialFiles).toHaveBeenCalledWith("acct123", expect.objectContaining({ keepAccount: true }));
	});

	it("every module that imports the HF hub SDK is a declared store, so a new bucket cannot escape the wipe", () => {
		expect(
			hfSdkImporters(),
			"A module now talks to @huggingface/hub. If it stores user data, wipeUserData must delete it and EXTERNAL_STORES must declare it."
		).toEqual([
			"src/lib/chat/server/storage/custodialStorage.ts",
			// A bucket the person linked is in their own Hugging Face account, not ours. The wipe
			// deletes our link and the sealed token (storage_locations, above) and leaves their files, as
			// the delete dialog says. (CUR-2930)
			"src/lib/chat/server/storage/locations/hfBucketLocation.ts",
			// Connect Hugging Face creates <user>/alpha-files in the person's own account, for the
			// same reason as above. The wipe deletes the storage_locations row and its sealed OAuth grant. (CUR-2932)
			"src/lib/chat/server/storage/locations/hfOAuth.ts",
		]);
	});
});
