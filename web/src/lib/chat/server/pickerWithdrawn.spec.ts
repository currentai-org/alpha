import { describe, expect, it } from "vitest";
import { PICKER, WITHDRAWN, pickerSites } from "../../../../config/picker";

// A model on config/picker.ts's WITHDRAWN list is off every site's picker, and the list says when
// someone decides again (CUR-4162). Past that date the unit job carries a warning, so bringing the model
// back, or moving the date in a reviewed PR, is a decision somebody makes rather than a list nobody reads.

function overdueWithdrawals(today: string): string[] {
	return WITHDRAWN.filter((w) => w.until < today).map(
		(w) => `${w.model} (${w.ticket}) was due back ${w.until}: restore it or move the date in a PR`
	);
}
describe("a withdrawn model stays off every picker, and only until its date (CUR-4162)", () => {
	it("is offered by no site's picker", () => {
		for (const { model } of WITHDRAWN) {
			const offering = pickerSites.filter((s) => PICKER[s].includes(model));
			expect(offering, `${model} is withdrawn but still offered on`).toEqual([]);
		}
	});

	// A warning and never a failure: if the upstream is still down on the date, a red here would hit every
	// develop run, the CI noise the withdrawal exists to stop. Vitest's GitHub Actions reporter turns each
	// annotation into a warning on the job.
	it("warns, and never fails, once a withdrawal's until date has passed", async ({ annotate }) => {
		const today = new Date().toISOString().slice(0, 10);
		for (const line of overdueWithdrawals(today)) await annotate(line, "warning");
		expect(overdueWithdrawals("9999-12-31").length).toBe(WITHDRAWN.length);
	});

	it("names a ticket, a real date and a reason for every withdrawal", () => {
		for (const w of WITHDRAWN) {
			expect(w.ticket).toMatch(/^[A-Z]+-\d+$/);
			expect(w.until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(Number.isNaN(Date.parse(w.until))).toBe(false);
			expect(w.why.length).toBeGreaterThan(10);
			expect(w.specTag).toMatch(/^needs-[a-z0-9-]+$/);
		}
	});

	it("leaves every site's picker with a default to open on", () => {
		for (const s of pickerSites) expect(PICKER[s].length, `${s}'s picker is empty`).toBeGreaterThan(0);
	});
});
