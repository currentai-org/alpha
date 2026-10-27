import { redirect } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";

export async function load({ params, parent, fetch }) {
	// There is no models list any more, and the rest parameter also matches a bare /chat/models: send
	// an old link to that list to the chat rather than open a chat with no model.
	if (!params.model) redirect(308, `${base}/`);

	await fetch(`${base}/api/v2/models/${params.model}/subscribe`, {
		method: "POST",
	});

	return {
		settings: await parent().then((data) => ({
			...data.settings,
			activeModel: params.model,
		})),
	};
}
