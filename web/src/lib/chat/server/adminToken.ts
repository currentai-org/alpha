// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import { config } from "$lib/chat/server/config";
import type { Session } from "$lib/chat/types/Session";
import { logger } from "./logger";
import { hmacSha256, timingSafeEqual } from "./crypto";
import { v4 } from "uuid";
import { deploymentUrl } from "$lib/server/runtimeEnv";

// Durable admin proof cookie. The in-memory `adminSessions` array below only works on a single
// long-lived process (upstream chat-ui's assumption); on Vercel serverless each function instance
// has its own memory, so an admin grant registered on instance A is invisible to instance B and the
// admin gate 403s intermittently. This cookie is a STATELESS, instance-independent proof: an
// HMAC(ADMIN_TOKEN, sessionId) that only a holder of ADMIN_TOKEN could mint, bound to one session so
// it can't be replayed against another. Read on every request to derive isAdmin.
export const ADMIN_PROOF_COOKIE = "admin-proof";

// HMAC label for the token compare in checkToken; not a secret, just domain separation.
const TOKEN_HASH_LABEL = "admin-token-check-v1";

class AdminTokenManager {
	private token = config.ADMIN_TOKEN || v4();
	// contains all session ids that are currently admin sessions (same-instance fast path only —
	// the durable cross-instance grant is the ADMIN_PROOF_COOKIE; see makeProof / verifyProof)
	private adminSessions: Array<Session["sessionId"]> = [];

	public get enabled() {
		// if open id is configured, disable the feature
		return config.ADMIN_CLI_LOGIN === "true";
	}
	public isAdmin(sessionId: Session["sessionId"]) {
		if (!this.enabled) return false;
		return this.adminSessions.includes(sessionId);
	}

	// HMAC key for the proof cookie. config.ADMIN_TOKEN is set in prod (stable across instances and
	// restarts → proofs stay valid); in dev it falls back to the per-process random token (fine, dev
	// is single-process). Rotating ADMIN_TOKEN invalidates outstanding proofs, which is correct.
	private proofKey(): string {
		return config.ADMIN_TOKEN || this.token;
	}

	/** Mint the durable admin proof for a session (set as ADMIN_PROOF_COOKIE on token validation). */
	public makeProof(sessionId: Session["sessionId"]): Promise<string> {
		return hmacSha256(this.proofKey(), sessionId);
	}

	/** Verify an admin-proof cookie against the current session. Stateless — no instance memory. */
	public async verifyProof(
		proof: string | undefined,
		sessionId: Session["sessionId"] | undefined
	): Promise<boolean> {
		if (!this.enabled || !proof || !sessionId) return false;
		return timingSafeEqual(proof, await this.makeProof(sessionId));
	}

	public async checkToken(token: string, sessionId: Session["sessionId"]): Promise<boolean> {
		if (!this.enabled) return false;
		// Constant-time over equal-length HMAC digests, never a raw string compare.
		const [supplied, expected] = await Promise.all([
			hmacSha256(TOKEN_HASH_LABEL, token),
			hmacSha256(TOKEN_HASH_LABEL, this.token),
		]);
		if (timingSafeEqual(supplied, expected)) {
			logger.info(`[ADMIN] Token validated`);
			this.adminSessions.push(sessionId);
			this.token = config.ADMIN_TOKEN || v4();
			return true;
		}

		return false;
	}

	public removeSession(sessionId: Session["sessionId"]) {
		this.adminSessions = this.adminSessions.filter((id) => id !== sessionId);
	}

	public displayToken() {
		// if admin token is set, don't display it
		if (!this.enabled || config.ADMIN_TOKEN) return;

		let port = process.env.PORT
			? parseInt(process.env.PORT)
			: process.argv.includes("--port")
				? parseInt(process.argv[process.argv.indexOf("--port") + 1])
				: undefined;

		if (!port) {
			const mode = process.argv.find((arg) => arg === "preview" || arg === "dev");
			if (mode === "preview") {
				port = 4173;
			} else if (mode === "dev") {
				port = 5173;
			} else {
				port = 3000;
			}
		}

		// This only runs when ADMIN_TOKEN is unset (the early return above), which in practice means
		// local development. It still prefers VERCEL_URL (the deployment's own host) over the static
		// PUBLIC_ORIGIN, in case it ever runs on a deployment where ADMIN_TOKEN is absent.
		const ownHost = deploymentUrl();
		const origin = ownHost
			? `https://${ownHost}`
			: config.PUBLIC_ORIGIN || `http://localhost:${port}`;
		const url = origin + "?token=";
		logger.info(`[ADMIN] You can login with ${url + this.token}`);
	}
}

export const adminTokenManager = new AdminTokenManager();
