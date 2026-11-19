// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import { config } from "$lib/chat/server/config";
import { MetricsServer } from "$lib/chat/server/metrics";

export async function GET() {
	if (config.METRICS_ENABLED !== "true") {
		return new Response("Not Found", { status: 404 });
	}

	const payload = await MetricsServer.getInstance().render();

	return new Response(payload, {
		status: 200,
		headers: {
			"Content-Type": "text/plain; version=0.0.4",
			"Cache-Control": "no-store",
		},
	});
}
