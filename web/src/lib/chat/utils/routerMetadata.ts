// The one merge of a RouterMetadata frame into a message's routing record, shared by the
// server reducer (streamUpdate.ts) and the live chat page (+page.svelte). A separate copy in either
// place could drop `backend` and `verifyMethod`, so the live badge would lose its "compute:"
// segment until a reload while the persisted record (and the provider stamp read from it) kept it.
//
// Last-non-empty-wins: route/model/provider/backend can arrive in separate frames, and an empty field
// in a later frame must not clobber a value an earlier frame set. verifyMethod merges on PRESENCE,
// because "" is a real "checked, unverified" signal (CUR-756). assistedBy merges by role (CUR-984).
import type { Message } from "$lib/chat/types/Message";
import type { MessageRouterMetadataUpdate } from "$lib/chat/types/MessageUpdate";
import { assistedByMerged } from "$lib/chat/messageProvenance";

type RouterMetadata = NonNullable<Message["routerMetadata"]>;

export function mergeRouterMetadata(
	existing: Message["routerMetadata"],
	update: Omit<MessageRouterMetadataUpdate, "type">
): RouterMetadata {
	const assistedBy = assistedByMerged(existing?.assistedBy, update.assistedBy);
	return {
		route: update.route || existing?.route || "",
		model: update.model || existing?.model || "",
		provider: update.provider || existing?.provider,
		backend: update.backend || existing?.backend,
		...(update.lane || existing?.lane ? { lane: update.lane || existing?.lane } : {}),
		...(update.appRegion || existing?.appRegion ? { appRegion: update.appRegion || existing?.appRegion } : {}),
		verifyMethod: update.verifyMethod !== undefined ? update.verifyMethod : existing?.verifyMethod,
		...(assistedBy ? { assistedBy } : {}),
		...(update.answerLanguage || existing?.answerLanguage
			? { answerLanguage: update.answerLanguage || existing?.answerLanguage }
			: {}),
	};
}

/** Whether the record says anything about who SERVED the turn. A record can exist holding only
 *  `assistedBy`, the helpers that ran before any answer did (CUR-984), and a turn that then errored
 *  has a record and no answer. Readers that took the record's presence to mean "a model answered"
 *  read this instead. */
export function servingRecorded(rm: Message["routerMetadata"]): boolean {
	return Boolean(rm && (rm.route || rm.model || rm.provider || rm.backend || rm.verifyMethod !== undefined));
}
