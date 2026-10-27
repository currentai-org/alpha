/**
 * Color scheme for the encapsulated `/chat` window.
 *
 * The chat is presented as a self-contained "app window" on the /chat page. Its
 * color scheme is controlled here by scoping a `.dark` class onto the WINDOW
 * WRAPPER only (see routes/chat/+layout.svelte) — never onto <html> — so the
 * surrounding page (site header, welcome band) stays in the light theme while the
 * window renders dark.
 *
 * Flip to `false` to render the window in the light theme, which is kept fully
 * intact. This is the single switch for that.
 *
 * NOTE: This constant only scopes dark to the chat window and does not touch the
 * global theme. Nothing puts .dark on <html>, so the site outside the chat stays light.
 */
export const CHAT_WINDOW_DARK = true;

/**
 * Default colour mode for the chat window under the Alpha design system. Users can switch between
 * light / dark / system from the sidebar ("Appearance"); the choice persists under this key.
 * Derived from CHAT_WINDOW_DARK so the one switch above still decides the out-of-box look.
 */
export const CHAT_WINDOW_DEFAULT_MODE: 'light' | 'dark' = CHAT_WINDOW_DARK ? 'dark' : 'light';
export const CHAT_MODE_STORAGE_KEY = 'alpha:mode';
/** Persisted design-system theme (seed set) for the chat window — see Settings → Appearance. */
export const CHAT_THEME_STORAGE_KEY = 'alpha:theme';

/** localStorage key for the person's custom theme (Settings → Appearance → Create your own). */
export const CHAT_CUSTOM_THEME_STORAGE_KEY = 'alpha:custom-theme';
