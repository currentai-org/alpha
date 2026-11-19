// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import { getContext, setContext } from "svelte";
import type { ArtifactRegistry } from "./artifacts";
import type { artifactPanel } from "$lib/chat/stores/artifactPanel.svelte";

/**
 * Context bridging ChatWindow (which derives the artifact registry from the
 * visible message path) and the inline ArtifactCard components rendered deep
 * inside ChatMessage.
 */
export interface ArtifactsContext {
	readonly registry: ArtifactRegistry;
	panel: typeof artifactPanel;
}

const KEY = Symbol("artifacts");

export function setArtifactsContext(ctx: ArtifactsContext): void {
	setContext(KEY, ctx);
}

export function getArtifactsContext(): ArtifactsContext | undefined {
	return getContext<ArtifactsContext | undefined>(KEY);
}
