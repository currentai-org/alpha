import { createHash } from 'node:crypto';

type ModelSettings = {
	preprompt?: string;
	parameters?: unknown;
	supportsArtifacts?: boolean;
	systemRoleSupported?: boolean;
	endpoints?: { type: string; modelId?: string; baseURL?: string }[];
};

/** Public opaque fingerprint of answer settings, excluding lane credentials and display metadata. */
export function evalFingerprint(model: ModelSettings): string {
	return createHash('sha256').update(JSON.stringify({
		preprompt: model.preprompt,
		parameters: model.parameters,
		supportsArtifacts: model.supportsArtifacts,
		systemRoleSupported: model.systemRoleSupported,
		lanes: model.endpoints?.map((e) => ({ type: e.type, modelId: e.modelId, baseURL: e.baseURL }))
	}, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
		? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
		: value)).digest('hex');
}
