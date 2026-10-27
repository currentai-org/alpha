import Root from './Root.svelte';
import Input from './Input.svelte';
import Portal from '../../internal/Portal.svelte';
import Positioner from '../../internal/Positioner.svelte';
import Popup from './Popup.svelte';
import Item from './Item.svelte';
import Empty from './Empty.svelte';
import Separator from './Separator.svelte';

/** Base UI `Combobox` namespace (Trigger and Icon folded into Input — see docs). */
export const Combobox = {
	Root,
	Input,
	Portal,
	Positioner,
	Popup,
	Item,
	Empty,
	Separator
};

export { fuzzyFilter, fuzzyScore, type FuzzyItem } from './fuzzy.ts';
