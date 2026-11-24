// $env/dynamic/public for an operator CLI: the PUBLIC_ keys of the process environment, as SvelteKit
// filters them for the server.
export const env: Record<string, string | undefined> = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => key.startsWith("PUBLIC_"))
);
