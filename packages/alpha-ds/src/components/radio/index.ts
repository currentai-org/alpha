import Group from './Group.svelte';
import Root from './Root.svelte';
import Indicator from './Indicator.svelte';

/** Base UI `RadioGroup` (the container). */
export const RadioGroup = Group;
/** Base UI `Radio` namespace: `<Radio.Root value="a"><Radio.Indicator/></Radio.Root>`. */
export const Radio = { Root, Indicator };
