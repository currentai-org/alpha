import Root from './Root.svelte';
import Trigger from './Trigger.svelte';
import Portal from '../../internal/Portal.svelte';
import Backdrop from './Backdrop.svelte';
import Popup from './Popup.svelte';
import Title from './Title.svelte';
import Description from './Description.svelte';
import Close from './Close.svelte';
import Action from './Action.svelte';

/** Base UI `AlertDialog` namespace (+ `Action`, see docs). */
export const AlertDialog = {
	Root,
	Trigger,
	Portal,
	Backdrop,
	Popup,
	Title,
	Description,
	Close,
	Action
};
