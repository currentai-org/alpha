/**
 * The dialect layer: once a base language is known, look for markers that single out a regional
 * variety. A variety matters for routing when a model is benchmarked on it separately (Valencian on
 * ALIA) or when support for it is weaker than for the standard language (Swiss German).
 *
 * Markers are spellings and words one variety uses and its neighbour doesn't — or, for Cantonese,
 * characters written only in Cantonese. They are a stand-in until a real classifier reports
 * varieties itself; a variety is only claimed on two or more markers (one for Cantonese characters,
 * which are unambiguous), and its confidence never exceeds the base language's.
 */
import type { LanguageDecision } from './classifier';

interface Variety {
	tag: string;
	/** Words (lower-case) or, with `chars`, single characters. */
	markers: string[];
	chars?: boolean;
	/** Markers needed before the variety is claimed. */
	min: number;
}

const VARIETIES: Record<string, Variety[]> = {
	deu: [
		{
			tag: 'gsw',
			min: 2,
			markers: ['isch', 'chasch', 'öppis', 'nöd', 'nüt', 'gsi', 'chunnt', 'grüezi', 'mitenand', 'bitzli', 'chum', 'säge', 'gaht', 'hät', 'gönd', 'luege', 'hoi', 'merci', 'vilmal']
		}
	],
	cat: [
		{
			tag: 'cat-valencia',
			min: 2,
			markers: ['xiquet', 'xiquets', 'xiqueta', 'xiquetes', 'eixir', 'hui', 'ací', 'meua', 'meues', 'teua', 'seua', 'vore', 'este', 'esta', 'estos', 'aplegar', 'vosté']
		}
	],
	por: [
		{
			tag: 'por-BR',
			min: 2,
			markers: ['você', 'vocês', 'ônibus', 'celular', 'pra', 'tá', 'cadê', 'oi', 'banheiro', 'geladeira', 'legal', 'bacana', 'trem', 'time']
		},
		{
			tag: 'por-PT',
			min: 2,
			markers: ['autocarro', 'telemóvel', 'frigorífico', 'comboio', 'fixe', 'rapariga', 'miúdo', 'estás', 'tu', 'casa-de-banho', 'pequeno-almoço', 'equipa']
		}
	],
	spa: [
		{
			tag: 'spa-AR',
			min: 2,
			markers: ['vos', 'sos', 'tenés', 'querés', 'podés', 'sabés', 'che', 'laburo', 'boludo', 'acá', 'colectivo', 'pibe']
		},
		{
			tag: 'spa-ES',
			min: 2,
			markers: ['vosotros', 'vosotras', 'os', 'habéis', 'tenéis', 'sois', 'queréis', 'podéis', 'ordenador', 'móvil', 'vale', 'tío', 'guay', 'zumo', 'coche']
		},
		{
			tag: 'spa-419',
			min: 2,
			markers: ['ustedes', 'computadora', 'celular', 'carro', 'jugo', 'chévere', 'platicar', 'ahorita', 'manejar', 'lindo', 'acá', 'plata']
		}
	],
	arb: [
		{
			tag: 'arz',
			min: 2,
			markers: ['ازيك', 'إزيك', 'عايز', 'عايزة', 'ايه', 'إيه', 'دلوقتي', 'كده', 'بتاع', 'فين', 'ليه', 'مش', 'اوي', 'أوي']
		}
	],
	cmn: [{ tag: 'yue', min: 1, chars: true, markers: ['嘅', '咗', '唔', '冇', '嗰', '啲', '佢', '睇', '乜', '喺', '嘢'] }]
};

function hits(text: string, v: Variety): number {
	if (v.chars) return v.markers.filter((c) => text.includes(c)).length;
	const words = new Set(
		text
			.toLowerCase()
			.split(/[^\p{L}\p{M}'-]+/u)
			.filter(Boolean)
	);
	return v.markers.filter((m) => words.has(m)).length;
}

/**
 * Refine a base-language decision to a variety when the markers say so. The base language moves to
 * the front of `alternatives`, so the router can still fall back to it.
 */
export function applyDialect(text: string, decision: LanguageDecision): LanguageDecision {
	const candidates = VARIETIES[decision.value];
	if (!candidates) return decision;
	let best: { tag: string; n: number } | undefined;
	for (const v of candidates) {
		const n = hits(text, v);
		if (n >= v.min && (!best || n > best.n)) best = { tag: v.tag, n };
	}
	if (!best) return decision;
	const confidence = Math.round(decision.confidence * Math.min(1, 0.7 + 0.1 * best.n) * 100) / 100;
	return {
		value: best.tag,
		confidence,
		alternatives: [{ value: decision.value, confidence: decision.confidence }, ...decision.alternatives].slice(0, 4),
		signal: 'dialect'
	};
}

/** Every variety tag the layer can report, for the routing lab's language list. */
export const VARIETY_TAGS = Object.values(VARIETIES).flatMap((vs) => vs.map((v) => v.tag));
