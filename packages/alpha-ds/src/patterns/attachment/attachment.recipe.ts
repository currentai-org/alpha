import { tv } from '../../internal/cn.ts';

/**
 * Attachment card: a fixed-height tile, one tier up from the surface behind it and unbordered, so a
 * row of them reads as content inside the composer or a message rather than as more controls. A
 * photo is a square thumbnail; any other file a wider card naming its type above its name.
 */
export const attachmentCardRecipe = tv({
	base: [
		'group/attachment relative h-16 shrink-0 overflow-hidden rounded-sharp bg-surface-raised text-fg-2',
		'transition-control data-[attachment=file]:w-42 data-[attachment=image]:w-16'
	]
});

/** Attachment row: one line of cards that scrolls sideways, fading at the edge that has more. */
export const attachmentRowRecipe = tv({
	base: 'flex w-full gap-2 overflow-x-auto overflow-y-hidden scroll-fade-x [scrollbar-width:none]'
});
