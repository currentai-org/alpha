import Root from './Root.svelte';
import Row from './Row.svelte';
import Pill from './Pill.svelte';
import Panel from './Panel.svelte';
import Notice from './Notice.svelte';

export { pillRecipe, panelRecipe, noticeRecipe } from './composer-accessory.recipe.ts';
/** Pattern: pills attached to the composer that open width-matched context panels, and notices on its top edge. */
export const ComposerAccessory = { Root, Row, Pill, Panel, Notice };
