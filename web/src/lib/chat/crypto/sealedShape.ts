// The sealed shape of a conversation (stage 3), with no dependency on age, so a
// page can ask "is anything here sealed?" without loading the cipher. The reader is sealedHistory.ts.
//
// A sealed message keeps a skeleton in plaintext, the fields named in `SKELETON_MESSAGE_FIELDS`, and
// carries every other field in one age file at `messages[i].sealed`: base64 of an age v1 file whose
// plaintext is a JSON `SealedEnvelope`. Sealed is the default, so a field added to `Message` later is
// sealed until someone names it as skeleton here. The title and the preprompt are sealed the same way
// at `sealedTitle` and `sealedPreprompt`.
//
// The envelope binds a blob to its slot (conversation id, kind, message id, and a revision the skeleton
// also carries), so a blob moved to another slot, or an older blob put back in its own, does not open.
// That binding is not authenticity. age encrypts to a public recipient, and anyone who holds it,
// including the server that seals on persist, can mint an envelope for any slot that opens and passes
// every check here. Authenticity comes from the per-message MAC (`sealedMac`): an HMAC under
// a server secret kept apart from the database, so a copy of the database cannot mint one.

import type { Message } from '$lib/chat/types/Message';
import type { MessageUpdate } from '$lib/chat/types/MessageUpdate';

/**
 * The message fields a sealed message keeps in plaintext. Every field not named here is sealed.
 *
 * Ids, tree links, timestamps, flags, and the routing and timing records the server writes, which
 * hold codes and model ids and no one's words, and `chars`, the length of the sealed `content`. `files` stays for its hashes and locations, with each
 * name blanked (names are sealed as `fileNames`). `updates` stays for its structure only
 * (`SKELETON_UPDATE_KEYS`), so a locked answer still reads as finished; its text is sealed.
 */
export const SKELETON_MESSAGE_FIELDS = [
	'id',
	'from',
	'ancestors',
	'children',
	'createdAt',
	'updatedAt',
	'interrupted',
	'score',
	'routerMetadata',
	'requestedModel',
	'agentRun',
	'timings',
	'rungs',
	'files',
	'updates',
	'sealed',
	'sealedRev',
	'sealedMac',
	'chars'
] as const satisfies readonly (keyof Message)[];

type SkeletonMessageField = (typeof SKELETON_MESSAGE_FIELDS)[number];

/** The keys of one update kept in the skeleton: what kind it is and whether it ends the turn. Every
 *  other key, the text among them, is in the sealed body's `updates`. */
const SKELETON_UPDATE_KEYS = ['type', 'subtype', 'status', 'interrupted', 'closed', 'handoff'] as const;

/** An update cut down to `SKELETON_UPDATE_KEYS`, or null for anything that is not an update. The one
 *  copy both the browser's reader and the server's sealer use, so they agree on what stays plaintext. */
export function updateSkeleton(update: unknown): MessageUpdate | null {
	if (typeof update !== 'object' || update === null || Array.isArray(update)) return null;
	const src = update as Record<string, unknown>;
	if (typeof src.type !== 'string') return null;
	const out: Record<string, unknown> = {};
	for (const k of SKELETON_UPDATE_KEYS) if (src[k] !== undefined) out[k] = src[k];
	return out as unknown as MessageUpdate;
}

/** The message fields that live in the sealed body. `sealedState` and `servedFromCache` are
 *  render-only and never stored. */
export type SealedMessageField = Exclude<keyof Message, SkeletonMessageField | 'sealedState' | 'servedFromCache'>;

type SealedMessageBody = Partial<Pick<Message, SealedMessageField>> & {
	/** The full updates, text included. The skeleton's `updates` holds only `SKELETON_UPDATE_KEYS`. */
	updates?: MessageUpdate[];
	/** Each file's name, keyed by its hash (`files[i].value`). The skeleton's names are empty. */
	fileNames?: Record<string, string>;
};

/**
 * What one sealed blob opens to. age has no associated data, so the envelope carries the place it was
 * sealed for, and the reader refuses a blob read from any other place.
 *
 * - `v`: 1. Any other version is refused.
 * - `kind`: which slot. A title blob in a message slot is refused, and the reverse.
 * - `conversationId`: the conversation's id, as the page's URL names it.
 * - `messageId`: the message's id, for `kind: "message"` only.
 * - `rev`: the slot's revision, a whole number the writer raises on every reseal. The skeleton carries
 *   the same number (`sealedRev`, `sealedTitleRev`, `sealedPrepromptRev`), and a blob whose `rev`
 *   differs is refused, so an older blob for the same slot cannot be put back under a newer skeleton.
 * - `salt`: 32 random bytes, base64url, for `message` and `preprompt`. The server's MAC
 *   covers it, and it exists only inside the blob, so a database copy plus the MAC key cannot test a
 *   guessed body against the stored MAC. The browser posts it back with the body. A blob sealed before
 *   it existed has none, and its MAC was taken without one.
 */
export type SealedEnvelope =
	| { v: 1; kind: 'message'; conversationId: string; messageId: string; rev: number; body: SealedMessageBody; salt?: string }
	| { v: 1; kind: 'title'; conversationId: string; rev: number; text: string }
	| { v: 1; kind: 'preprompt'; conversationId: string; rev: number; text: string; salt?: string };

/** The shape of an envelope's `salt`: 32 bytes as unpadded base64url. */
export const MAC_SALT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Why a sealed part shows no text: no unlocked key in this browser, or a blob that would not open
 *  for this place (wrong key, damaged, stale, or bound to another message or conversation). */
export type SealedState = 'locked' | 'unreadable';

/** The parts of a conversation the reader looks at. */
export type SealableConversation = {
	id: string;
	title?: string;
	preprompt?: string;
	sealedTitle?: string;
	sealedTitleRev?: number;
	sealedPreprompt?: string;
	sealedPrepromptRev?: number;
	/** The person's Personalization instructions win over the conversation's own, so `preprompt` is
	 *  theirs and the opened sealed preprompt is kept only for the turn to post back. */
	personalInstructionsApply?: boolean;
	messages: Message[];
};

/** Is anything in this conversation sealed? False for every conversation written before stage 4. */
export function hasSealedFields(doc: Pick<SealableConversation, 'messages'> & Partial<SealableConversation>): boolean {
	return Boolean(doc.sealedTitle || doc.sealedPreprompt || doc.messages?.some((m) => m.sealed));
}

/** Does an opened view show a sealed part it could not open? Reloading after an unlock helps only then. */
export function showsClosedSealedParts(view: {
	messages?: Pick<Message, 'sealedState'>[];
	titleState?: SealedState;
	prepromptState?: SealedState;
}): boolean {
	return Boolean(view.titleState || view.prepromptState || view.messages?.some((m) => m.sealedState));
}
