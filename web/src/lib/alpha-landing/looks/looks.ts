/**
 * The /alpha page has several visual directions ("looks") side by side while the design settles.
 * `?look=<id>` picks one; the Look (Dev) group in PageOptions, shown on dev builds only, writes that parameter.
 */

const ALL_LOOKS = [
	{ id: 'classic', label: 'Classic', hint: 'The first page: centred hero on paper' },
	{ id: 'handover', label: 'Handover', hint: 'After the design handover file' },
	{ id: 'bold', label: 'Bold', hint: 'Patterns, scale and motion' }
] as const;

export type LookId = (typeof ALL_LOOKS)[number]['id'];

// The Handover look is built from the website's button block, which the public snapshot leaves out;
// without that file the look is not offered and `?look=handover` falls back to the default.
const hasHandover = Object.keys(import.meta.glob('./handover/HandoverLook.svelte')).length > 0;
export const LOOKS = ALL_LOOKS.filter((look) => look.id !== 'handover' || hasHandover);

export const DEFAULT_LOOK: LookId = 'bold';

export const LOOK_PARAM = 'look';

/** The look a `?look=` value names, or the default for anything else. */
export function parseLook(value: string | null | undefined): LookId {
	return LOOKS.find((look) => look.id === value)?.id ?? DEFAULT_LOOK;
}
