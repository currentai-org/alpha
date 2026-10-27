import Root from './Root.svelte';
import Label from './Label.svelte';
import Description from './Description.svelte';
import Error from './Error.svelte';
import Control from '../input/Input.svelte';

/** Base UI `Field` namespace: `<Field.Root><Field.Label/><Field.Control/>…</Field.Root>`. */
export const Field = { Root, Label, Control, Description, Error };
