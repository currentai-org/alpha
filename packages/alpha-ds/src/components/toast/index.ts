import Provider from './Provider.svelte';
import Viewport from './Viewport.svelte';
import Root from './Root.svelte';
import Title from './Title.svelte';
import Description from './Description.svelte';
import Close from './Close.svelte';

export {
	createToastManager,
	toastManager,
	useToastManager,
	type ToastOptions,
	type ToastItem,
	type ToastManager
} from './manager.svelte.ts';

/** Base UI `Toast` namespace. Add toasts with `useToastManager().add({...})`. */
export const Toast = { Provider, Viewport, Root, Title, Description, Close };
