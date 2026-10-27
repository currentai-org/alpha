// Every settings page renders on the server (CUR-908), so a reload, a typed URL or a return from an
// OAuth provider arrives with content rather than an empty shell. Browser-only calls in these
// pages run from onMount, $effect or a click handler, none of which run on the server. The rendered
// HTML carries the visitor's session and settings, so hooks/handle.ts marks /settings `no-store`.
export const ssr = true;
