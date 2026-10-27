import { CHAT_API_PATH } from "$lib/chat/paths";

// A read-aloud clip's remote URL (the HF Space's `/gradio_api/file=...` route) loads through a plain
// fetch(), but the same URL handed straight to an <audio>/Audio element as `src` can stall forever:
// readyState 0, networkState 2, no error. Fetching the bytes ourselves and handing the element a
// local blob: URL avoids whatever the media element's own request does differently against the
// Space's file route (Range headers, credentials mode).
//
// Rejects on a non-OK response, a network error, or after `timeoutMs`, so a caller can show a real
// failure state instead of a play button that never does anything. A read-aloud clip from our own
// speech route is synthesized while it is fetched (CUR-3151), which took up to 14 s in probes.
export async function loadAudioClip(
	url: string,
	timeoutMs = url.startsWith(`${CHAT_API_PATH}/speech/`) ? 30_000 : 10_000
): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) throw new Error(`audio fetch failed: ${response.status}`);
		const blob = await response.blob();
		return URL.createObjectURL(blob);
	} finally {
		clearTimeout(timer);
	}
}
