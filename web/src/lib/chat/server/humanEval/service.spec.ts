// An open language with no stored answers. A person must hear "nothing to rate yet" before
// they consent, and "you've rated every answer" only after they have rated one. The database calls are
// stubbed; humanEval.flow.spec.ts drives the same service against a real Postgres. (CUR-4263)
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	candidatesFor: vi.fn(),
	ratingsByUser: vi.fn(),
	getProfile: vi.fn(),
	getRun: vi.fn(),
	languagesWithAnswers: vi.fn(),
}));

vi.mock("$lib/chat/server/db/humanEval", () => ({
	...db,
	countRatingsSince: vi.fn(),
	ratingRowsFor: vi.fn(),
	DAILY_RATING_CAP: 50,
	incrementFailedChecks: vi.fn(),
	insertRating: vi.fn(),
	quarantineRatings: vi.fn(),
	markCalibrationSeen: vi.fn(),
}));
vi.mock("./gate", () => ({ humanEvalEnabled: () => true, includeDraftLanguages: () => true }));
const picker = vi.hoisted(() => ({ forceNone: false }));
vi.mock("./nextItem", async (actual) => {
	const real = await actual<typeof import("./nextItem")>();
	return { pickNext: (input: Parameters<typeof real.pickNext>[0]) => (picker.forceNone ? null : real.pickNext(input)) };
});

import { TASK_SET } from "./config";
import { answersToRate, nextItemFor } from "./service";

const LANGUAGE = "ita";
const TASK = TASK_SET.tasks[0].id;
const answer = (runId: string, isCheck = false) => ({ runId, modelId: "m", taskId: TASK, validRatings: 0, isCheck });
const calibrated = { id: "p1", calibrationSeenAt: new Date(), failedChecks: 0, level: "native" };

beforeEach(() => {
	vi.resetAllMocks();
	picker.forceNone = false;
	db.ratingsByUser.mockResolvedValue([]);
});

describe("nextItemFor in an open language with no stored answers", () => {
	it("says there is nothing to rate before asking for consent, not after", async () => {
		db.candidatesFor.mockResolvedValue([]);
		db.getProfile.mockResolvedValue(null);
		expect(await nextItemFor("u1", LANGUAGE)).toEqual({ kind: "empty", language: LANGUAGE });
		expect(db.getProfile, "the consent step was reached for a language with nothing to rate").not.toHaveBeenCalled();
	});

	it("counts check items as nothing to rate, since they are only ever served between real answers", async () => {
		db.candidatesFor.mockResolvedValue([answer("c1", true)]);
		db.getProfile.mockResolvedValue(null);
		expect((await nextItemFor("u1", LANGUAGE)).kind).toBe("empty");
	});

	it("never tells a person who has rated nothing that they rated every answer", async () => {
		// A consented, calibrated person, and answers that exist but none the picker will serve.
		db.candidatesFor.mockResolvedValue([answer("r1")]);
		db.getProfile.mockResolvedValue(calibrated);
		db.ratingsByUser.mockResolvedValue([]);
		picker.forceNone = true;
		expect((await nextItemFor("u1", LANGUAGE)).kind).toBe("empty");
	});
});

describe("nextItemFor once there are answers", () => {
	it("still asks for consent first when stored answers exist", async () => {
		db.candidatesFor.mockResolvedValue([answer("r1")]);
		db.getProfile.mockResolvedValue(null);
		expect((await nextItemFor("u1", LANGUAGE)).kind).toBe("needs_profile");
	});

	it("says every answer is rated only after this person has rated one", async () => {
		db.candidatesFor.mockResolvedValue([answer("r1")]);
		db.getProfile.mockResolvedValue(calibrated);
		db.ratingsByUser.mockResolvedValue([{ runId: "r1", taskId: TASK }]);
		expect(await nextItemFor("u1", LANGUAGE)).toEqual({ kind: "done", language: LANGUAGE });
	});
});

describe("answersToRate", () => {
	it("marks an open language with no stored answers false, so the page offers no Start for it", async () => {
		db.languagesWithAnswers.mockResolvedValue(new Set(["fra"]));
		expect(await answersToRate(["fra", "ita", "por"])).toEqual({ fra: true, ita: false, por: false });
		expect(db.languagesWithAnswers).toHaveBeenCalledWith(TASK_SET.version);
	});
});
