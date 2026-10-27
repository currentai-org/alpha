import { AUTH_BASE_PATH, HF_LOGIN_CALLBACK_PATH, base } from "$lib/chat/paths";
import { OIDConfig } from "$lib/chat/server/auth";
import { config } from "$lib/chat/server/config";
import { APP_NAME } from "$lib/chat/constants/app";
import { authOrigins } from "$lib/chat/server/authOrigins";

function huggingFaceCallbackOrigins(requestOrigin: string): string[] {
	const origins = authOrigins(config.PUBLIC_ORIGIN || undefined, process.env);
	return origins.length > 0 ? origins : [requestOrigin];
}

/**
 * See https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/
 */
export const GET = ({ url }) => {
	if (!OIDConfig.CLIENT_ID) {
		return new Response("Client ID not found", { status: 404 });
	}
	if (OIDConfig.CLIENT_ID !== "__CIMD__") {
		return new Response(
			`Client ID is manually set to something other than '__CIMD__': ${OIDConfig.CLIENT_ID}`,
			{
				status: 404,
			}
		);
	}
	return new Response(
		JSON.stringify({
			client_id: new URL(url, config.PUBLIC_ORIGIN || url.origin).toString(),
			client_name: APP_NAME,
			client_uri: `${config.PUBLIC_ORIGIN || url.origin}${base}`,
			redirect_uris: [
				// auth.ts's own OIDC flow.
				new URL(HF_LOGIN_CALLBACK_PATH, config.PUBLIC_ORIGIN || url.origin).toString(),
				// betterAuth.ts's genericOAuth HF provider, a second consumer of this same
				// CLIENT_ID='__CIMD__' identity; unlisted, HF rejects its callback as an unregistered
				// redirect_uri. One per host sign-in answers on, so chat.aipotluck.org's callback is
				// registered too (CUR-1067). client_id stays on PUBLIC_ORIGIN: HF identifies the app by
				// this document's URL.
				...huggingFaceCallbackOrigins(url.origin).map((origin) =>
					new URL(`${AUTH_BASE_PATH}/callback/huggingface`, origin).toString()
				),
			],
			token_endpoint_auth_method: "none",
			scopes: OIDConfig.SCOPES,
		}),
		{
			headers: {
				"Content-Type": "application/json",
			},
		}
	);
};
