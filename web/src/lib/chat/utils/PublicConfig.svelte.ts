import type { env as publicEnv } from "$env/dynamic/public";
import { page } from "$app/state";
import { staticAssetPath } from "$lib/chat/paths";

import type { Transporter } from "@sveltejs/kit";
import { getContext } from "svelte";

type PublicConfigKey = keyof typeof publicEnv;

class PublicConfigManager {
	#configStore = $state<Record<PublicConfigKey, string>>({});

	constructor(initialConfig?: Record<PublicConfigKey, string>) {
		this.init = this.init.bind(this);
		this.getPublicConfig = this.getPublicConfig.bind(this);
		if (initialConfig) {
			this.init(initialConfig);
		}
	}

	init(publicConfig: Record<PublicConfigKey, string>) {
		this.#configStore = publicConfig;
	}

	get(key: PublicConfigKey) {
		return this.#configStore[key];
	}

	getPublicConfig() {
		return this.#configStore;
	}

	get isHuggingChat() {
		return this.#configStore.PUBLIC_APP_ASSETS === "huggingchat";
	}

	get assetPath() {
		// CUR-1172 sibling: PUBLIC_ORIGIN is one value shared by every preview deployment, so
		// preferring it here would point favicons/manifest.json/OG-image tags at develop.aipotluck.org from
		// every per-PR preview — a cross-origin fetch a browser can refuse outright
		// for a PWA manifest. page.url.origin is always the host actually serving this page; fall back
		// to PUBLIC_ORIGIN only when it's unavailable (prerendering outside a real request).
		return (
			(page.url.origin || this.#configStore.PUBLIC_ORIGIN) +
			staticAssetPath(this.#configStore.PUBLIC_APP_ASSETS || "chatui")
		);
	}
}
type ConfigProxy = PublicConfigManager & { [K in PublicConfigKey]: string };

export function getConfigManager(initialConfig?: Record<PublicConfigKey, string>) {
	const publicConfigManager = new PublicConfigManager(initialConfig);

	const publicConfig: ConfigProxy = new Proxy(publicConfigManager, {
		get(target, prop) {
			if (prop in target) {
				return Reflect.get(target, prop);
			}
			if (typeof prop === "string") {
				return target.get(prop as PublicConfigKey);
			}
			return undefined;
		},
		set(target, prop, value, receiver) {
			if (prop in target) {
				return Reflect.set(target, prop, value, receiver);
			}
			return false;
		},
	}) as ConfigProxy;
	return publicConfig;
}

export const publicConfigTransporter: Transporter = {
	encode: (value) =>
		value instanceof PublicConfigManager ? JSON.stringify(value.getPublicConfig()) : false,
	decode: (value) => getConfigManager(JSON.parse(value)),
};

export const usePublicConfig = () => getContext<ConfigProxy>("publicConfig");
