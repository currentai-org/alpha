import Root from './Root.svelte';
import Input from './Input.svelte';
import Toolbar from './Toolbar.svelte';
import Tools from './Tools.svelte';
import Send from './Send.svelte';
import Chip from './Chip.svelte';

export { getComposer } from './context.ts';
/** Pattern: the message composer. */
export const Composer = { Root, Input, Toolbar, Tools, Chip, Send };
