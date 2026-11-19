// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
export interface Route {
	name: string;
	description: string;
	primary_model: string;
	fallback_models?: string[];
}

export interface RouteConfig {
	name: string;
	description: string;
}

export interface RouteSelection {
	routeName: string;
}
