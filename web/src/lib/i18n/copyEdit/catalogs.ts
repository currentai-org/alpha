// The message catalogs as written (web/messages/*.json), loaded only when copy edit mode opens. The
// editor shows a message's template, `{placeholders}` and all, not the text a page rendered from it.
import { locales } from '$lib/i18n/locales';

type Catalog = Record<string, string>;

const loaders = import.meta.glob('/messages/*.json', { import: 'default' }) as Record<
	string,
	() => Promise<Catalog>
>;

let loaded: Record<string, Catalog> | undefined;

export async function loadCatalogs(): Promise<Record<string, Catalog>> {
	if (loaded) return loaded;
	const entries = await Promise.all(
		locales.map(
			async (locale) => [locale, (await loaders[`/messages/${locale}.json`]?.()) ?? {}] as const
		)
	);
	loaded = Object.fromEntries(entries);
	return loaded;
}

/** A message's source template in `locale`, falling back to English where it is not translated yet. */
export function sourceTemplate(
	catalogs: Record<string, Catalog>,
	locale: string,
	key: string
): string {
	return catalogs[locale]?.[key] ?? catalogs.en?.[key] ?? '';
}
