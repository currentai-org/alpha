// The /chat subtree is fully dynamic (auth, DB, streaming) — never prerender it; keep SSR on.
export const prerender = false;
export const ssr = true;
