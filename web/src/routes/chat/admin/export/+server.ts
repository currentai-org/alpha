import { error } from "@sveltejs/kit";

// This route's entire reason to exist was `shareConversationsWithModelAuthors` — export the
// conversations of users who opted into model-author sharing, and upload them to a Hugging Face
// dataset. The toggle's UI, type, and API schema entries are gone (no user can see or set it), so the
// route is retired. Keeping it "working" — filtering on a stale value nobody can revoke — would be
// worse than retiring it loudly: a 410 says exactly what happened and why, rather than quietly
// exporting rows against consent nobody gave.
//
// A real "share conversations with model authors" feature, if wanted again, needs its own deliberate,
// visible, revocable consent flow designed from scratch — not a silent revival of this one's leftover
// column. See migration 0015 for the accompanying purge of the stale value from existing rows.
export async function POST() {
	error(
		410,
		"Conversation export by model-author consent was retired (CUR-741/CUR-915) — the toggle it read no longer exists anywhere a user could set it."
	);
}
