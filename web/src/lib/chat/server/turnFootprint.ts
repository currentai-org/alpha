import {
	computeLlmImpacts,
	electricityMixes,
	isParametersMoE,
	isRangeValue,
	llmImpacts,
	logger as impactsLogger,
	models as impactModels,
	PROVIDER_CONFIG_MAP,
	type Providers,
	type ValueOrRange,
} from "@ecologits/ecologits.js";
import { catalogBaseOf, orgs, type CatalogModel } from "$lib/chat/routing/catalog";
import {
	MessageUpdateType,
	type MessageFootprintUpdate,
	type FootprintRange,
} from "$lib/chat/types/MessageUpdate";
import { logger } from "./logger";

/**
 * Energy and water for one answer, from the EcoLogits methodology (`@ecologits/ecologits.js`, which
 * runs in-process: its model and electricity-mix data are compiled into the package and it makes no
 * network calls). Inputs are the turn's real output-token count from the provider's usage report and
 * the measured generation time. The catalog's `footprint` field supplies the model's size. A model
 * without one is reported as not estimated, never given a stand-in figure.
 */

// EcoLogits' warnings ("multimodal architecture, expect lower precision") go to our logger at debug
// level instead of the console.
impactsLogger.setSink((level, message) => {
	if (level === "error") logger.warn({ source: "ecologits" }, message);
	else logger.debug({ source: "ecologits" }, message);
});

/** The EcoLogits provider whose own datacentre figures apply when that provider serves the model. */
const ORG_TO_IMPACT_PROVIDER: Readonly<Record<string, Providers>> = {
	mistral: "mistralai",
	cohere: "cohere",
	huggingface: "huggingface_hub",
};

/** ISO 3166-1 alpha-3 zone for the countries a catalog host org records. */
const COUNTRY_ZONES: Readonly<Record<string, string>> = {
	Switzerland: "CHE",
	France: "FRA",
	Poland: "POL",
	Spain: "ESP",
	Singapore: "SGP",
	"United States": "USA",
	Canada: "CAN",
	China: "CHN",
};

/**
 * The electricity-mix zone of the country the catalog records for a model's host. With no country
 * on record it is "WOR", EcoLogits' world average.
 */
function hostZone(model: Pick<CatalogModel, "provider">): string {
	const region = model.provider ? orgs[model.provider]?.region : undefined;
	const zone = region ? COUNTRY_ZONES[region] : undefined;
	return zone && electricityMixes.findElectricityMix(zone) ? zone : "WOR";
}

function toRange(v: ValueOrRange | undefined | null, scale: number): FootprintRange | null {
	if (v === undefined || v === null) return null;
	if (isRangeValue(v)) return { min: v.min * scale, max: v.max * scale };
	return { min: v * scale, max: v * scale };
}

interface TurnInputs {
	/** The served model id, as the provider or gateway names it. */
	modelId: string;
	outputTokens: number;
	/** Wall time of the generation, in seconds. */
	latencySeconds: number;
}

/**
 * Energy (Wh) and water (litres) for one answer as ranges, or null figures with `estimated: false`
 * when the catalog has no size facts for the model.
 */
export function turnFootprint({ modelId, outputTokens, latencySeconds }: TurnInputs): MessageFootprintUpdate {
	const base = { type: MessageUpdateType.Footprint as const, model: modelId, outputTokens };
	const unpriced: MessageFootprintUpdate = { ...base, estimated: false, energyWh: null, waterL: null };
	const entry = catalogBaseOf(modelId);
	const facts = entry?.footprint;
	if (!entry || !facts || outputTokens <= 0) return unpriced;
	// EcoLogits treats latency as an upper bound on generation time; never pass zero.
	const requestLatency = Math.max(latencySeconds, 0.001);

	let active: ValueOrRange;
	let total: ValueOrRange;
	if ("ecologits" in facts) {
		const registered = impactModels.findModel(facts.ecologits.provider, facts.ecologits.model);
		if (!registered) return unpriced;
		// Served by the registry entry's own provider: EcoLogits' own figures for that provider apply.
		const servingProvider = entry.provider ? ORG_TO_IMPACT_PROVIDER[entry.provider] : undefined;
		if (servingProvider === registered.provider) {
			const out = llmImpacts({
				provider: facts.ecologits.provider,
				modelName: facts.ecologits.model,
				outputTokenCount: outputTokens,
				requestLatency,
			});
			if (out.hasErrors) return unpriced;
			return {
				...base,
				estimated: true,
				energyWh: toRange(out.energy?.value, 1000),
				waterL: toRange(out.wcf?.value, 1),
			};
		}
		const params = registered.architecture.parameters;
		active = isParametersMoE(params) ? params.active : params;
		total = isParametersMoE(params) ? params.total : params;
	} else {
		total = facts.parametersB.total;
		active = facts.parametersB.active ?? facts.parametersB.total;
	}

	// Another host: its country's electricity mix, and EcoLogits' generic hosted-inference datacentre
	// (its huggingface_hub figures) for PUE and WUE, since no host publishes its own.
	const mix = electricityMixes.findElectricityMix(hostZone(entry));
	if (!mix) return unpriced;
	const datacenter = PROVIDER_CONFIG_MAP.huggingface_hub;
	const impacts = computeLlmImpacts({
		modelActiveParameterCount: active,
		modelTotalParameterCount: total,
		outputTokenCount: outputTokens,
		requestLatency,
		ifElectricityMixAdpe: mix.adpe,
		ifElectricityMixPe: mix.pe,
		ifElectricityMixGwp: mix.gwp,
		ifElectricityMixWue: mix.wue,
		datacenterPue: datacenter.datacenterPue,
		datacenterWue: datacenter.datacenterWue,
	});
	return {
		...base,
		estimated: true,
		energyWh: toRange(impacts.energy.value, 1000),
		waterL: toRange(impacts.wcf.value, 1),
	};
}

/**
 * Collects what one generation reports, for its single footprint update. A host may report usage
 * more than once (GLM does); the largest count is the whole turn's, and summing would count it
 * twice. `price` is a parameter so a test can make the estimate fail.
 */
export function createFootprintMeter(
	fallbackModelId: string,
	now: () => number = Date.now,
	price: typeof turnFootprint = turnFootprint
) {
	const startedAt = now();
	let outputTokens = 0;
	let servedModelId: string | undefined;
	return {
		noteServedModel(id: string | undefined) {
			if (id) servedModelId = id;
		},
		noteUsage(completionTokens: number | undefined) {
			outputTokens = Math.max(outputTokens, completionTokens ?? 0);
		},
		/**
		 * The turn's one update, as a list so a caller can `yield*` it: empty for a turn that reported no
		 * usage (the page then keeps its own text-length estimate) or when the estimate failed, which
		 * never costs the visitor their answer.
		 */
		finish(): MessageFootprintUpdate[] {
			if (outputTokens <= 0) return [];
			try {
				return [
					price({
						modelId: servedModelId ?? fallbackModelId,
						outputTokens,
						latencySeconds: (now() - startedAt) / 1000,
					}),
				];
			} catch (e) {
				logger.warn({ err: e }, "[footprint] estimate failed");
				return [];
			}
		},
	};
}
