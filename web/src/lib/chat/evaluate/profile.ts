import type { DeclaredLevel } from './types';

/** The levels a rater declares, as the API names them, with what each means. */
export const LEVELS: { value: DeclaredLevel; label: string; hint: string }[] = [
	{ value: 'native', label: 'Native', hint: 'It’s my first language, or I grew up speaking it.' },
	{ value: 'fluent', label: 'Fluent', hint: 'I read and write it easily, every day.' },
	{ value: 'working', label: 'Working', hint: 'I can read and write it, with some effort.' }
];

const key = (language: string) => `alpha:eval-profile:${language}`;

/**
 * The level and variety declared on this device, per language. Finishing the worked example posts
 * the profile again (the API's `calibrationDone` rides on the profile call), so the page needs them
 * back even after a reload.
 */
export function rememberedProfile(language: string): { level: DeclaredLevel; variety: string | null } | null {
	try {
		const raw = localStorage.getItem(key(language));
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

export function rememberProfile(language: string, profile: { level: DeclaredLevel; variety: string | null }) {
	try {
		localStorage.setItem(key(language), JSON.stringify(profile));
	} catch {
		/* storage unavailable: asked again if needed */
	}
}
