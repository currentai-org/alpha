import { roadmapPublicProducts } from "$lib/website.server";
import { humanEvalEnabled } from "$lib/chat/server/humanEval/gate";
import type { PageServerLoad } from "./$types";

// The roadmap's open gaps — products marked "Looking for partner" that aren't live yet. Read on the
// server so the 180 kB roadmap payload never ships to the settings page; only the few rows it shows do.
// Benchmarks and datasets lead, since they're what Auto's model routing and the language-gap notice
// ask people for.
const FIRST = ["local-benchmarks", "benchmark-evaluation-datasets", "pretraining-datasets", "query-router"];

export const load: PageServerLoad = async () => {
	const open = (await roadmapPublicProducts()).filter(
		(p) => p.status !== "live" && p.gaps.some((g) => /partner/i.test(g))
	).sort((a, b) => rank(a.name) - rank(b.name));
	return {
		evaluationOpen: humanEvalEnabled(),
		openGaps: open.slice(0, 6).map((p) => ({
			id: p.id,
			name: p.name,
			emoji: p.emoji,
			description: p.description,
			status: p.status,
		})),
	};
};

function rank(name: string): number {
	const i = FIRST.indexOf(name);
	return i === -1 ? FIRST.length : i;
}
