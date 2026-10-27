import iconCodepoints from './icons.json' with { type: 'json' };

/** Site-wide icon set — generated from `shared/icons` via `pnpm build` in that package. */
const labelFor = (id: string) => id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' ');

export type IconId = keyof typeof iconCodepoints & string;

export const ICON_REGISTRY = Object.fromEntries(
	Object.keys(iconCodepoints).map((id) => [id, { label: labelFor(id) }])
) as Record<IconId, { label: string }>;

/** CSS class for a generated icon-font glyph (`icons.generated.css`). */
export function iconClass(id: IconId): string {
	return `icon-${id}`;
}

export function isIconId(value: string): value is IconId {
	return value in iconCodepoints;
}
