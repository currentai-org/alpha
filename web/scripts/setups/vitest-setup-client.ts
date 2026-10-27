import { vi } from "vitest";

// Load the real app stylesheet into the browser test environment.
//
// Without it, component tests run with no CSS at all: every Tailwind class is inert, nothing can
// overflow or be constrained, and any assertion about computed style is really an assertion about the
// harness. For example, `.thinking-viewport` is capped by `max-h-56`; with no stylesheet it never
// overflows, so the `has-overflow` fade mask it binds to never applies.
//
// Loading it here is what makes visual-behaviour assertions mean anything.
import "../../src/app.css";

// `$env/dynamic/public`'s real virtual module reads a global SvelteKit only injects into a served
// page's HTML — real Chromium (this project's `browser.enabled` runner) never gets that injection,
// so importing it throws `Cannot read properties of undefined (reading 'env')` before a single test
// runs. vitest-setup-server.ts mocks this same module for the node project; the client project never
// needed to until a browser-tested component's import graph reached it (payload/client.ts's
// `payloadOrigin()`). Mocked to a plain, mutable object so a test can still set the one key it cares
// about — see lexical-renderer.svelte.test.ts's own beforeEach.
vi.mock("$env/dynamic/public", () => ({
	env: {},
}));
