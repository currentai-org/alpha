import Root from './Root.svelte';
import Trigger from './Trigger.svelte';
import Value from './Value.svelte';
import Icon from './Icon.svelte';
import Portal from '../../internal/Portal.svelte';
import Positioner from '../../internal/Positioner.svelte';
import Popup from './Popup.svelte';
import Item from './Item.svelte';
import Group from './Group.svelte';
import GroupLabel from './GroupLabel.svelte';
import Separator from '../menu/Separator.svelte';

/** Base UI `Select` namespace (ItemText/ItemIndicator folded into Item — see docs). */
export const Select = {
	Root,
	Trigger,
	Value,
	Icon,
	Portal,
	Positioner,
	Popup,
	Item,
	Group,
	GroupLabel,
	Separator
};
