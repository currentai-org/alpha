// Which stored answer a person rates next in a language: the one with the fewest valid ratings that
// they have not rated, not the same task twice in a row (back-to-back answers to one request invite
// comparing them), spread across models, and a check item (quality.ts) every tenth rating.

export type Candidate = {
	runId: string;
	modelId: string;
	taskId: string;
	/** Valid ratings this answer already has, from anyone. */
	validRatings: number;
	/** A known-bad answer used as a check. Never counted in results. */
	isCheck?: boolean;
};

export type NextItemInput = {
	candidates: Candidate[];
	/** Answers this person already rated (any validity). */
	ratedRunIds: Set<string>;
	/** Task of the answer this person rated last in this language, if any. */
	lastTaskId?: string | null;
	/** How many ratings this person has submitted in this language. */
	ratingsSoFar: number;
	random?: () => number;
};

const CHECK_EVERY = 10;

export function pickNext(input: NextItemInput): Candidate | null {
	const random = input.random ?? Math.random;
	const unseen = input.candidates.filter((c) => !input.ratedRunIds.has(c.runId));

	const checks = unseen.filter((c) => c.isCheck);
	const regular = unseen.filter((c) => !c.isCheck);

	// The 10th, 20th, ... rating is a check item when one is left. Never the very first rating, which
	// is where the calibration example already sits.
	const position = input.ratingsSoFar + 1;
	if (checks.length && position > 1 && position % CHECK_EVERY === 0) {
		return checks[Math.floor(random() * checks.length)];
	}
	if (!regular.length) return null;

	let pool = regular;
	if (input.lastTaskId) {
		const otherTask = regular.filter((c) => c.taskId !== input.lastTaskId);
		if (otherTask.length) pool = otherTask;
	}

	const fewest = Math.min(...pool.map((c) => c.validRatings));
	const tied = pool.filter((c) => c.validRatings === fewest);

	// Among equally rated answers, spread across models first: the model with the fewest valid
	// ratings over all its answers in this language goes first.
	const byModel = new Map<string, number>();
	for (const c of input.candidates.filter((c) => !c.isCheck)) {
		byModel.set(c.modelId, (byModel.get(c.modelId) ?? 0) + c.validRatings);
	}
	const fewestModel = Math.min(...tied.map((c) => byModel.get(c.modelId) ?? 0));
	const finalists = tied.filter((c) => (byModel.get(c.modelId) ?? 0) === fewestModel);
	return finalists[Math.floor(random() * finalists.length)];
}
