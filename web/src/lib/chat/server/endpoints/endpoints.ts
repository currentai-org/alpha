// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import { endpointOai } from "./openai/endpointOai";
import { endpointAgent } from "./agent/endpointAgent";

// The endpoint type surface (Endpoint, EndpointParameters, EndpointMessage,
// TextGenerationStreamOutputSimplified) lives in ./types — a leaf module the endpoint
// implementations can import without cycling back through this registry.

// list of all endpoint generators
export const endpoints = {
	openai: endpointOai,
	agent: endpointAgent,
};

// The registry's endpoint schema is models.ts's registryEndpointSchema, which holds a key's env var
// name and never its value.
export default endpoints;
