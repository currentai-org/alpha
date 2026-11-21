// The picture the safety screen judges: the chat turn's screen (prepareTurnMedia.ts) and the stored
// picture screen (storage/uploadImageGuard.ts) both build it here, so the two cannot drift apart.
//
// The 1024×1024 box is a cap on bytes, never a target size: a picture smaller than the box is sent at
// its own size, since enlarging it changes what the screen judges.
import type sharp from "sharp";

const SCREEN_RENDITION_MAX_PX = 1024;
const SCREEN_RENDITION_JPEG_QUALITY = 85;

/** A JPEG that fits inside 1024×1024, scaled down when larger and never scaled up. Rejects when sharp
 *  cannot read the bytes; each caller turns that into an UNKNOWN unit. */
export async function screenRendition(sharpFn: typeof sharp, bytes: Buffer | Uint8Array): Promise<Buffer> {
	return sharpFn(bytes)
		.resize({
			width: SCREEN_RENDITION_MAX_PX,
			height: SCREEN_RENDITION_MAX_PX,
			fit: "inside",
			withoutEnlargement: true,
		})
		.jpeg({ quality: SCREEN_RENDITION_JPEG_QUALITY })
		.toBuffer();
}
