import type { Conversation } from "$lib/chat/types/Conversation";
import type { MessageFile } from "$lib/chat/types/Message";
import { sha256 } from "$lib/chat/utils/sha256";
import { fileTypeFromBuffer } from "file-type";
import { putFile } from "$lib/chat/server/db/files";

export async function uploadFile(file: File, conv: Conversation): Promise<MessageFile> {
	const sha = await sha256(await file.text());
	const buffer = await file.arrayBuffer();

	// Attempt to detect the mime type of the file, fallback to the uploaded mime
	const mime = await fileTypeFromBuffer(buffer).then((fileType) => fileType?.mime ?? file.type);

	// Filename mirrors the GridFS convention so downloadFile can locate it: `${convId}-${sha}`.
	await putFile({
		filename: `${conv._id.toString()}-${sha}`,
		conversationId: conv._id.toString(),
		mime,
		data: Buffer.from(buffer),
	});

	return { type: "hash", value: sha, mime: file.type, name: file.name };
}
