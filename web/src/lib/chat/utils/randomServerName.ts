/**
 * A friendly default name for a machine someone is about to pair (CUR-3168).
 *
 * The managed-server form asks for a name before there is anything to look at, and "what should I
 * call it?" is a worse first question than it sounds: the name is only a label in a list, so any
 * answer is right, which is exactly why people stall on it. Pre-filling one makes the field a thing
 * to accept rather than a thing to invent, while staying obviously editable.
 *
 * Adjective + animal rather than a serial number or a UUID fragment: a person has to recognise this
 * row later among their own machines, and "Amber Otter" is far easier to hold onto than "Server 3".
 * Deliberately not derived from anything about the device — a name taken from the hostname or the
 * network would leak more than the person chose to share, and we do not have either at this point
 * anyway.
 */

// Short, concrete, and inoffensive in the languages Alpha serves. No colours that double as moods,
// no adjectives that could read as a judgement about the machine or its owner.
const ADJECTIVES = [
	"amber", "brave", "bright", "calm", "clever", "cosy", "curious", "eager",
	"gentle", "golden", "happy", "humble", "jolly", "keen", "kind", "lively",
	"lucky", "merry", "mellow", "nimble", "patient", "quiet", "rapid", "silver",
	"snowy", "spry", "sunny", "swift", "tidy", "warm", "willing", "zesty",
] as const;

const ANIMALS = [
	"badger", "beaver", "bison", "crane", "dolphin", "falcon", "ferret", "finch",
	"gecko", "heron", "ibex", "jackal", "koala", "lemur", "lynx", "magpie",
	"marten", "moth", "newt", "osprey", "otter", "panda", "puffin", "quail",
	"raven", "robin", "salmon", "sparrow", "stoat", "tapir", "walrus", "wombat",
] as const;

/** Title-cases one word; the lists are stored lowercase so they stay easy to scan and extend. */
function capitalise(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

function pick<T>(items: readonly T[]): T {
	// Math.random, not crypto: this is a cosmetic default a person reads and edits, not a secret
	// and not an identifier anything is keyed on. Collisions are harmless — two machines may share
	// a suggested name, and the person renames one.
	return items[Math.floor(Math.random() * items.length)];
}

/** e.g. "Amber Otter". 32 × 32 = 1,024 combinations — enough that a repeat inside one session is
 *  unlikely, few enough that every pair stays readable. */
export function randomServerName(): string {
	return `${capitalise(pick(ADJECTIVES))} ${capitalise(pick(ANIMALS))}`;
}
