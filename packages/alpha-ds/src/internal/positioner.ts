/**
 * Base UI splits a floating part into `Positioner` (where it goes) and `Popup` (what it looks
 * like). bits-ui folds both into one `Content`. This context lets our parts keep Base UI's
 * anatomy: `<X.Positioner side="top">` records placement, `<X.Popup>` reads it and hands the
 * merged props to the engine.
 */
import { getContext, setContext } from 'svelte';

export interface PositionerProps {
	side?: 'top' | 'right' | 'bottom' | 'left';
	sideOffset?: number;
	align?: 'start' | 'center' | 'end';
	alignOffset?: number;
	collisionPadding?: number;
	avoidCollisions?: boolean;
	sticky?: 'partial' | 'always';
	arrowPadding?: number;
}

const KEY = Symbol('alpha-ds.positioner');

export function setPositioner(get: () => PositionerProps): void {
	setContext(KEY, get);
}

export function getPositioner(defaults: PositionerProps = {}): PositionerProps {
	const get = getContext<(() => PositionerProps) | undefined>(KEY);
	return { sideOffset: 6, collisionPadding: 8, ...defaults, ...(get?.() ?? {}) };
}
