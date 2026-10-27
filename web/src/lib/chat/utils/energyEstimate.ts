/**
 * Honest, auditable energy ESTIMATE for a chat session.
 *
 * We have NO per-request power telemetry from the serving datacenter, so this is a
 * model, not a measurement. The UI must therefore only ever present it as "est." with
 * the methodology exposed (see SessionFootprint.svelte). Every constant below is an
 * educated guess and is labeled as one.
 *
 * Chain modeled: show the *true* cost, not the flattering
 * marginal-GPU number, and name what we leave out:
 *   1. Inference compute   — output tokens x J/token for a 70B model on GH200 (marginal)
 *   2. Idle amortization   — the node draws power whether or not you chat; a fraction is
 *                            amortized onto each response (the squishiest guess)
 *   3. Datacenter overhead — PUE (cooling, power conversion, networking)
 * Explicitly EXCLUDED, and the UI says so: embodied hardware manufacturing, the one-time
 * model-training energy amortized per query, and cooling water.
 *
 * Headline figure uses a central per-token energy estimate; the lo/hi band is retained for
 * the methodology copy so we can be honest that the real value is uncertain by ~an order of
 * magnitude.
 */

// ~4 English characters per token (OpenAI's rule of thumb). A guess: real tokenization
// varies with language, code, and whitespace. We have no token usage from the stream, so
// output length is the only signal we have.
const CHARS_PER_TOKEN = 4;

// Marginal inference energy per OUTPUT token — a 70B dense model on an NVIDIA GH200 at a
// realistic serving batch. Educated guess; published figures span roughly 0.5–3 J/token.
// This central figure (not their arithmetic mean) drives the headline; the band drives the
// "uncertain by ~10x" tooltip line.
export const J_PER_OUTPUT_TOKEN = 1.5;
export const J_PER_OUTPUT_TOKEN_LO = 0.5;
export const J_PER_OUTPUT_TOKEN_HI = 3.0;

// Fraction of inference energy added to amortize idle / low-batch node draw across
// requests. A pure guess — there is no public CSCS per-request idle figure. This is the
// least certain link in the chain and the tooltip flags it as such.
export const IDLE_AMORTIZATION = 0.4;

// Power Usage Effectiveness. CSCS "Alps" is hydro-powered and efficiently cooled; modern
// efficient datacenters run ~1.1–1.2. Guess: 1.15. (Lower is better; 1.0 = no overhead.)
export const PUE = 1.15;

const J_PER_WH = 3600;

/** Rough token count from response text. An estimate (we have no real usage data). */
export function estimateTokensFromText(text: string): number {
	if (!text) return 0;
	return Math.round(text.length / CHARS_PER_TOKEN);
}

/** Apply one per-token figure through idle-amortization and PUE; returns Wh. */
function chainWh(outputTokens: number, jPerToken: number): number {
	const inferenceJ = outputTokens * jPerToken;
	const withIdleJ = inferenceJ * (1 + IDLE_AMORTIZATION);
	const totalJ = withIdleJ * PUE;
	return totalJ / J_PER_WH;
}

/**
 * How the headline figure splits across the modelled chain, as shares summing to 1 — derived from
 * the same constants as the estimate, so the chart can never disagree with the number:
 * compute = 1, idle = IDLE_AMORTIZATION, datacenter overhead = (1 + idle) × (PUE − 1).
 */
export function energyBreakdown(): { compute: number; idle: number; overhead: number } {
	const compute = 1;
	const idle = IDLE_AMORTIZATION;
	const overhead = (1 + IDLE_AMORTIZATION) * (PUE - 1);
	const total = compute + idle + overhead;
	return { compute: compute / total, idle: idle / total, overhead: overhead / total };
}

/** Google's published median energy for one text prompt to its AI (Aug 2025), for scale. */
export const TYPICAL_AI_PROMPT_WH = 0.24;

/** Headline session energy estimate in Wh (central per-token figure). */
export function estimateEnergyWh(outputTokens: number): number {
	return chainWh(outputTokens, J_PER_OUTPUT_TOKEN);
}

/** Plausibility band (Wh) from the lo/hi per-token figures, for the methodology copy. */
export function estimateEnergyBandWh(outputTokens: number): { lo: number; hi: number } {
	return {
		lo: chainWh(outputTokens, J_PER_OUTPUT_TOKEN_LO),
		hi: chainWh(outputTokens, J_PER_OUTPUT_TOKEN_HI),
	};
}

/** Compact human-readable energy string, e.g. "1.2 Wh" or "84 mWh". */
export function formatEnergy(wh: number): string {
	if (wh < 0.095) return `${Math.round(wh * 1000)} mWh`;
	if (wh < 1) return `${wh.toFixed(2)} Wh`;
	return `${wh.toFixed(1)} Wh`;
}

/**
 * Everyday reference amounts for the session meter, smallest first. Round, conservative figures:
 * a phone battery is ~4,000 mAh × 3.85 V ≈ 15 Wh; a laptop battery ~50–70 Wh; heating a litre of
 * water from tap temperature to boiling is 4.18 kJ/kg·K × 1 kg × 80 K ≈ 93 Wh (plus kettle losses).
 */
export const ENERGY_ANCHORS = [
	{ wh: 15, label: "one phone charge", short: "1 phone charge" },
	{ wh: 60, label: "one laptop charge", short: "1 laptop charge" },
	{ wh: 100, label: "boiling a litre of water", short: "1 kettle boil" },
] as const;

/**
 * The reference the session meter fills toward: the smallest everyday amount that is still at least
 * the session's usage, so the bar is always meaningful ("a quarter of a phone charge") instead of a
 * sliver of an arbitrary 500 Wh. Past the largest anchor it counts kettle boils.
 */
export function energyAnchor(wh: number): { wh: number; label: string; short: string } {
	const hit = ENERGY_ANCHORS.find((a) => wh <= a.wh);
	if (hit) return hit;
	const kettles = Math.ceil(wh / 100);
	return { wh: kettles * 100, label: `boiling ${kettles} litres of water`, short: `${kettles} kettle boils` };
}

/**
 * Terse "0.3Wh" / "12Wh" figure for the session bar (SessionFootprint's header
 * and compact triggers). Distinct from formatEnergy — that one keeps the spaced "1.2 Wh" / "84
 * mWh" style used in the detail Modal, which this restyle deliberately leaves untouched.
 */
export function formatEnergyShort(wh: number): string {
	if (wh <= 0) return "0Wh";
	// One decimal of Wh rounds a real first reply (~10 mWh) to "0.0Wh", which reads as the
	// counter resetting right after the bloom card showed "~10 mWh". Below that rounding floor, mWh. (CUR-1694)
	if (wh < 0.05) return `${Math.max(1, Math.round(wh * 1000))}mWh`;
	if (wh < 10) return `${wh.toFixed(1)}Wh`;
	return `${Math.round(wh)}Wh`;
}

/**
 * Terse "0m" / "45m" / "2h" / "2h5m" figure for the Alpha mockup's session bar. Distinct from
 * localizedElapsed (energyCopy.ts) — that one keeps the "under a minute" / "3 min" / "1 hr 2 min" phrasing used in
 * the detail Modal, which this restyle deliberately leaves untouched.
 */
export function formatElapsedShort(ms: number): string {
	const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
}
