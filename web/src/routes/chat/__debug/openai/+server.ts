import { error } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { dev } from "$app/environment";
import { config } from "$lib/chat/server/config";
const DEFAULT_OPENAI_BASE = "https://router.huggingface.co/v1";

export async function GET() {
	// Dev-only: this echoes OPENAI_BASE_URL (the inference host) and a sample of upstream /models.
	// In prod that would publish the sovereign infra hostname to anyone with the URL — 404 instead.
	if (!dev) throw error(404, "Not found");
	const base = (config.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE).replace(/\/$/, "");
	try {
		const res = await fetch(`${base}/models`);
		const text = await res.text();
		let length: number | null = null;
		try {
			const parsed = JSON.parse(text);
			length = Array.isArray(parsed?.data) ? parsed.data.length : null;
		} catch (_err) {
			length = null; // ignore parse errors
		}
		return json({ base, status: res.status, ok: res.ok, length, sample: text.slice(0, 1000) });
	} catch (e) {
		return json({ base, error: String(e) });
	}
}
