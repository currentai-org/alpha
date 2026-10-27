import Card from './Card.svelte';
import Row from './Row.svelte';

export { attachmentCardRecipe, attachmentRowRecipe } from './attachment.recipe.ts';
/** Pattern: files attached to a message, as photo thumbnails and file cards in one row. */
export const Attachment = { Row, Card };
