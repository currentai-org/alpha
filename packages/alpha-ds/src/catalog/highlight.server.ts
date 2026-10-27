/**
 * Server-side syntax highlighting for the catalog. Shiki runs only on the server, so no grammar or
 * theme ships to the browser. The theme is Shiki's CSS-variables theme: token colours are
 * `--shiki-*` variables that `ui/code.css` maps onto design tokens, so code blocks follow the
 * active theme and light/dark mode like everything else.
 */
import { createCssVariablesTheme, createHighlighter, type Highlighter } from 'shiki';

const theme = createCssVariablesTheme({
	name: 'alpha-ds',
	variablePrefix: '--shiki-',
	fontStyle: true
});
const LANGS = ['svelte', 'typescript', 'css', 'bash', 'json', 'markdown'] as const;
export type CodeLang = (typeof LANGS)[number];

let highlighter: Promise<Highlighter> | undefined;

function getHighlighter(): Promise<Highlighter> {
	highlighter ??= createHighlighter({ themes: [theme], langs: [...LANGS] });
	return highlighter;
}

export async function highlight(code: string, lang: CodeLang = 'svelte'): Promise<string> {
	const h = await getHighlighter();
	return h.codeToHtml(code.trimEnd(), { lang, theme: 'alpha-ds' });
}
