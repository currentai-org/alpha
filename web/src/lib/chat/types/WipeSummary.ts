/**
 * Result of the GDPR "clear everything we hold about you" wipe behind the trash-all. Returned by the
 * DELETE /api/v2/conversations endpoint and shown back to the user as the post-wipe reassurance panel,
 * so this shape is shared by the server (wipeUserData) and the client (DeleteAllConversationsModal).
 */
export interface WipeSummary {
	conversations: number;
	settings: number;
	messageEvents: number;
	contributions: number;
	/** Rows in `local_inference_endpoints` (a user's own LAN/self-hosted server config) —
	 *  keyed by userId with an onDelete-cascade FK, but deleted explicitly here too (like
	 *  account/passkey/session below) rather than relied on silently, so this summary — and (CUR-1194)
	 *  wipeCoverage.spec.ts's completeness gate — both see it. */
	localInferenceEndpoints: number;
	/** Buckets of the person's own that they had linked as storage locations (the
	 *  `storage_locations` rows, with our sealed copy of each credential). Unlinked, never emptied: the (CUR-2930)
	 *  files in their own bucket are theirs and stay there. */
	storageLocations: number;
	/** Declined-message records (`safety_events`) deleted: every kind except `child_safety`, which is
	 *  retained under Art. 17(3). */
	safetyEvents: number;
	/** Files deleted from custodial storage (the HF bucket under users/<id>/). `undefined` when this
	 *  deployment has no custodial storage configured, or for a guest wipe (guests cannot upload). */
	custodialFiles?: number;
	/** Human evaluation ratings and language profiles deleted (A2, CUR-1914). Published results are
	 *  aggregates recomputed from the remaining ratings, so nothing of the person remains in them. */
	humanEvalRatings?: number;
	humanEvalProfiles?: number;
	/** Safety reports detached + RETAINED (not deleted) for legal compliance — disclosed to the user. */
	reportsRetained: number;
	/** The account itself (Better Auth's account/passkey/session/user rows, plus the shadow (CUR-434)
	 *  users row) was deleted. False for a guest wipe — there's no account to delete. */
	accountDeleted: boolean;
	/** agent-mode task rows deleted from agent-service's own store. `undefined` (not shown
	 *  on the reassurance panel) when agent mode is off for this deployment or the call didn't (CUR-1722)
	 *  complete — never a claim of zero when the truth is unknown. */
	agentServiceTasksDeleted?: number;
}
