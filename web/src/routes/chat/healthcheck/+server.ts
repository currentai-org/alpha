import { ensureModelsReady, registryCanServe } from "$lib/chat/server/models";
import { activeMasterKid, runCustodialCanary } from "$lib/chat/server/storage/custodialCrypto";
import { runInBackground } from "$lib/chat/server/vercelBackground";

// "Is this instance able to serve a chat turn", not "is a process listening".
//
// A literal "OK"/200 would let a deployment serving "No models available" pass every health
// check (CUR-1246): the registry can build with nothing a visitor could pick, so the page renders
// with no composer while this endpoint, the deploy gate reading it and the post-deploy smoke net
// all report the deployment healthy.
//
// TWO conditions, because the first alone is not enough. `ensureModelsReady` is the gate hooks.handle
// puts in front of every request, so awaiting it asks what a visitor's first request asks. But the gate
// answers on the registry's LENGTH, and a registry of five unlisted entries — the agent model and the
// compare panel — is non-empty and serves nobody. That is the state CUR-1246 produced, and this
// endpoint would answer 200 through it. `registryCanServe()` asks the question that actually matters.
//
// Cheap: both are synchronous once the registry is populated.
//
// The response also names the custodial master kid this instance would seal new keys to,
// so a key rotation can be confirmed per deployment, and the first call per instance starts the
// seal-and-open canary. Neither changes the status: storage is not what this endpoint answers for.
// The canary runs under waitUntil (CUR-4431) so it is not frozen with the response; a floating
// promise would count the frozen time in its `ms`. (CUR-4115)
export async function GET() {
	void runInBackground(runCustodialCanary());
	try {
		await ensureModelsReady();
	} catch (err) {
		return unavailable("the model registry is unavailable", err);
	}
	if (!registryCanServe()) {
		return unavailable("the model registry holds no model a visitor can send a message to");
	}
	return new Response("OK", { status: 200, headers: { "x-custodial-master-kid": activeMasterKid() ?? "none" } });
}

function unavailable(reason: string, err?: unknown): Response {
	return new Response(
		JSON.stringify({
			ok: false,
			reason: `${reason} — this instance cannot serve a chat turn`,
			...(err === undefined ? {} : { detail: err instanceof Error ? err.message : String(err) }),
		}),
		{ status: 503, headers: { "content-type": "application/json" } }
	);
}
