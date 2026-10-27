/**
 * What a click inside the embedded demo (the /alpha landing page) was trying to do, so the demo can
 * respond like the real app where it can — start a new chat, open another sample conversation —
 * and only point to the full app for things that genuinely need it (settings, accounts). Sign-up is
 * reserved for sending a message, the one action that would call a model.
 */
export type EmbeddedIntent =
	| { kind: 'new-chat'; prompt?: string }
	| { kind: 'conversation'; id: string }
	| { kind: 'app'; label?: string }
	/** The account row's Sign up — opens the demo's sign-up card without a draft. */
	| { kind: 'signup' };
