// Alpha storage as a StorageLocation. A thin wrapper: quota, rate, type sniff, CSAM scan and
// the users/<id>/ ownership check all stay in custodialStorage.ts, unchanged. (CUR-2930)
import { CUSTODIAL_MAX_BYTES_PER_FILE } from "$lib/chat/constants/custodialUpload";
import {
	deleteCustodialFile,
	downloadCustodialFile,
	listCustodialFiles,
	uploadCustodialFile,
	type UploadOptions,
} from "../custodialStorage";
import { userPrefix } from "../custodialBucket";
import { ALPHA_LOCATION_ID, type LocationFolder, type StorageLocation } from "./types";

export function custodialLocation(userId: string): StorageLocation {
	return {
		id: ALPHA_LOCATION_ID,
		kind: "alpha",
		label: "Alpha storage",
		capabilities: () => ({
			serverSideCopyWithin: true,
			maxTransferBytes: CUSTODIAL_MAX_BYTES_PER_FILE,
			grant: "bucket",
			listsSealedSizes: true,
		}),
		async list() {
			return (await listCustodialFiles(userId)).map((e) => ({ path: e.path, size: e.size }));
		},
		async stat(path) {
			const hit = (await listCustodialFiles(userId)).find((e) => e.path === path);
			return hit ? { size: hit.size, hash: hit.xetHash ?? hit.oid } : null;
		},
		read: (path) => downloadCustodialFile(userId, path),
		async write(folder: LocationFolder, name: string, content: Blob, opts: UploadOptions) {
			await uploadCustodialFile(userId, `${folder}/${name}`, content, opts);
			return `${userPrefix(userId)}${folder}/${name}`;
		},
		delete: (path) => deleteCustodialFile(userId, path),
	};
}
