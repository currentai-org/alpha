import { models } from "$lib/chat/server/models";
import { evalFingerprint } from '$lib/chat/server/evalFingerprint';
import evaluationGeneration from '$lib/chat/server/data/eval/generation-v1.json';
import { modelTakesImagesNow } from "$lib/chat/server/textOnly";
import type { RequestHandler } from "@sveltejs/kit";

// `private`: the list varies per caller again, because whether a model takes images is the
// per-account `multimodal` flag (CUR-2725). Don't loosen it to a shared cache.
const MODELS_CACHE_HEADERS = { "Cache-Control": "private, max-age=60" };

export const GET: RequestHandler = async () => {
	const res = models
		.filter((m) => m.unlisted == false)
		.map((model) => ({
			id: model.id,
			evaluationFingerprint: evalFingerprint(model),
			evaluationPipelineRevision: evaluationGeneration.pipelineRevision,
			name: model.name,
			websiteUrl: model.websiteUrl ?? "https://huggingface.co",
			modelUrl: model.modelUrl ?? "https://huggingface.co",
			// tokenizer removed in this build
			datasetName: model.datasetName,
			datasetUrl: model.datasetUrl,
			displayName: model.displayName,
			description: model.description ?? "",
			logoUrl: model.logoUrl,
			promptExamples: model.promptExamples ?? [],
			preprompt: model.preprompt ?? "",
			multimodal: modelTakesImagesNow(model),
			supportsTools: (model as unknown as { supportsTools?: boolean }).supportsTools ?? false,
			supportsReasoning:
				(model as unknown as { supportsReasoning?: boolean }).supportsReasoning ?? false,
			supportsArtifacts:
				(model as unknown as { supportsArtifacts?: boolean }).supportsArtifacts ?? false,
			unlisted: model.unlisted ?? false,
			hasInferenceAPI: model.hasInferenceAPI ?? false,
		}));
	return Response.json(res, { headers: MODELS_CACHE_HEADERS });
};
