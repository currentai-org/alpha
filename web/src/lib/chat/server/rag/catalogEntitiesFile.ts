// The catalog-entities index as a file the server reads at runtime, never a module.
// Imported as JSON it is parsed into the module graph by `vite build` and svelte-check, and the
// daily catalog sync grows it past what their heap can hold. `?url` makes it a server
// asset instead: SvelteKit copies it next to the function and `read` opens it, so the parse happens
// once, on the first retrieval, in the running server.
import { readFile } from "node:fs/promises";
import { read } from "$app/server";
import catalogEntitiesUrl from "./data/catalog-entities.json?url";

export async function readCatalogEntities(): Promise<unknown> {
	try {
		return await read(catalogEntitiesUrl).json();
	} catch (err) {
		// `read` is implemented only by a built server's adapter. Under vite-node (the evals) and
		// vitest it throws, and without the entity chunks the RAG
		// collision probe would rank our own pages alone and could not see them crowded out.
		// The source file sits beside this module there, so read it from disk instead.
		const onDisk = new URL("./data/catalog-entities.json", import.meta.url);
		const text = await readFile(onDisk, "utf8").catch(() => {
			throw err;
		});
		return JSON.parse(text);
	}
}
