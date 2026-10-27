import { base } from "$lib/chat/paths";
import { redirect } from "@sveltejs/kit";
import { settingsDevTools } from "$lib/chat/settingsSections";

export async function load({ parent, params }) {
	const data = await parent();

	const model = data.models.find((m: { id: string }) => m.id === params.model);

	// Developer-only (the local dev server, or an admin), like the Model settings list and both nav
	// entries: a visitor who has the URL anyway lands on Settings rather than a page the nav never
	// shows them.
	if (!settingsDevTools(data) || !model || model.unlisted) {
		redirect(302, `${base}/settings`);
	}

	return data;
}
