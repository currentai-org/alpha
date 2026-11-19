// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import type { BackendModel } from "$lib/chat/server/models";

export type Model = Pick<
	BackendModel,
	| "id"
	| "name"
	| "displayName"
	| "isRouter"
	| "websiteUrl"
	| "datasetName"
	| "promptExamples"
	| "parameters"
	| "description"
	| "logoUrl"
	| "modelUrl"
	| "datasetUrl"
	| "preprompt"
	| "multimodal"
	| "multimodalAcceptedMimetypes"
	| "unlisted"
	| "hasInferenceAPI"
	| "providers"
	| "supportsTools"
	| "supportsReasoning"
	| "supportsArtifacts"
> & { knownWeakSpot?: string };
