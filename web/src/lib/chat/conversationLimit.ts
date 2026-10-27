// The conversation cap's refusal names both counts and how many to delete. Sign-in moves a
// guest's conversations onto the account with no cap check, so an account can sit far past the limit,
// and "Delete some" at 173 of 100 means 74. (CUR-2891)

/** The 429 text for someone holding `count` conversations against a cap of `limit` (count >= limit). */
export function conversationLimitMessage(count: number, limit: number): string {
	const toDelete = count - limit + 1;
	const held = count === 1 ? "1 conversation" : `${count} conversations`;
	return `You have ${held} and the limit is ${limit}. Delete ${toDelete} to start a new one.`;
}
