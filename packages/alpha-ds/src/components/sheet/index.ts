import Root from './Root.svelte';
import Portal from '../../internal/Portal.svelte';
import Backdrop from '../dialog/Backdrop.svelte';
import Popup from './Popup.svelte';
import Header from './Header.svelte';
import Body from './Body.svelte';
import Description from '../dialog/Description.svelte';

export { useCompact, COMPACT_QUERY } from './compact.svelte.ts';
/** Alpha `Sheet` — a mobile-native bottom sheet. */
export const Sheet = { Root, Portal, Backdrop, Popup, Header, Body, Description };
