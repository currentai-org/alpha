import { z } from "zod";

// The shape /chat/api/v2/models and the layout data publish for each model (CUR-2640). zod objects
// strip keys they don't name, so a field added to the registry, or anything the gateway catalog
// returns per provider, stays server-side until someone adds it here. The registry declares
// `providers` and `parameters` with `.passthrough()`, which is why those two are narrowed rather
// than copied. Types stay loose (optional past id, name and displayName): a parse failure empties
// the picker, and the registry leaves `hasInferenceAPI` and `isRouter` unset on most models.
const publicProviderSchema = z.object({
	provider: z.string().optional(),
	supports_tools: z.boolean().optional(),
});

const publicParametersSchema = z.object({
	temperature: z.number().optional(),
	truncate: z.number().optional(),
	max_tokens: z.number().optional(),
	stop: z.array(z.string()).optional(),
	top_p: z.number().optional(),
	top_k: z.number().optional(),
	frequency_penalty: z.number().optional(),
	presence_penalty: z.number().optional(),
});

const publicModelSchema = z.object({
	id: z.string(),
	name: z.string(),
	websiteUrl: z.string().optional(),
	modelUrl: z.string().optional(),
	datasetName: z.string().optional(),
	datasetUrl: z.string().optional(),
	displayName: z.string(),
	localEndpointKind: z.enum(["direct", "managed"]).optional(),
	description: z.string().optional(),
	knownWeakSpot: z.string().optional(),
	logoUrl: z.string().optional(),
	providers: z.array(publicProviderSchema).optional(),
	promptExamples: z.array(z.object({ title: z.string(), prompt: z.string() })).optional(),
	parameters: publicParametersSchema.optional(),
	preprompt: z.string().optional(),
	multimodal: z.boolean().optional(),
	multimodalAcceptedMimetypes: z.array(z.string()).optional(),
	supportsTools: z.boolean().optional(),
	supportsReasoning: z.boolean().optional(),
	supportsArtifacts: z.boolean().optional(),
	unlisted: z.boolean().optional(),
	hasInferenceAPI: z.boolean().optional(),
	isRouter: z.boolean().optional(),
});

export const publicModelsSchema = z.array(publicModelSchema);
