import { m } from "$lib/paraglide/messages.js";

/** Where this deployment keeps people's files: CUSTODIAL_STORAGE_BACKEND, as the chat shell loads it. */
export type FileStore = "hf-bucket" | "s3" | "local";

/** The file store a page's data carries, or the Hugging Face bucket where none is loaded. */
export function fileStoreOf(data: unknown): FileStore {
	const store = (data as { fileStore?: FileStore | null } | null | undefined)?.fileStore;
	return store ?? "hf-bucket";
}

/** The Data & privacy sentence on where uploaded files are kept, naming the store this deployment uses. */
export function filesHomeCopy(store: FileStore, linked: boolean, organisation: string): string {
	if (store === "local")
		return linked ? m.data_filesHomeLocalLinked({ organisation }) : m.data_filesHomeLocal({ organisation });
	if (store === "s3") return linked ? m.data_filesHomeS3Linked({ organisation }) : m.data_filesHomeS3({ organisation });
	return linked ? m.data_filesHomeLinked({ organisation }) : m.data_filesHome({ organisation });
}

/** The storage panel's paragraph on where files are kept, naming the store this deployment uses. */
export function whereKeptCopy(store: FileStore, linked: boolean, organisation: string): string {
	if (store === "local")
		return linked
			? m.storage_whereKeptBodyLocalLinked({ organisation })
			: m.storage_whereKeptBodyLocal({ organisation });
	if (store === "s3")
		return linked ? m.storage_whereKeptBodyS3Linked({ organisation }) : m.storage_whereKeptBodyS3({ organisation });
	return linked ? m.storage_whereKeptBodyLinked({ organisation }) : m.storage_whereKeptBody({ organisation });
}
