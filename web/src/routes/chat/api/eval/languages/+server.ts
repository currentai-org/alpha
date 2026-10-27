// Languages open for human evaluation, the varieties the evaluation page offers for each (CUR-1914), and
// whether each has stored answers to rate yet (CUR-4263).
import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { openLanguages, varietiesFor } from "$lib/chat/server/humanEval/config";
import { humanEvalEnabled, includeDraftLanguages } from "$lib/chat/server/humanEval/gate";
import { answersToRate } from "$lib/chat/server/humanEval/service";

export const GET: RequestHandler = async () => {
	if (!humanEvalEnabled()) throw error(404, "Not found");
	const open = openLanguages(includeDraftLanguages());
	// An open language can still have no stored answers (CUR-4263): the page says so instead of offering Start.
	const hasAnswers = await answersToRate(open.map((l) => l.id));
	return json({
		languages: open.map((l) => ({
			id: l.id,
			name: l.name,
			dir: l.dir,
			varieties: varietiesFor(l.id),
			hasAnswers: hasAnswers[l.id],
		})),
	});
};
