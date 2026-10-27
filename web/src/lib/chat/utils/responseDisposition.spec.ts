import { describe, it, expect } from "vitest";
import { detectResponseDisposition } from "./responseDisposition";

describe("detectResponseDisposition — names what the model actually did", () => {
	it("self-declined: a model safety refusal (the live frog-blast case)", () => {
		const t =
			"I'm sorry, but I cannot assist with that request. It seems to involve a potentially harmful action. For safety reasons, I cannot provide guidance on unsafe actions.";
		expect(detectResponseDisposition(t)).toBe("self-declined");
	});

	it("self-declined: a policy refusal to engage", () => {
		expect(
			detectResponseDisposition("I cannot help with that — it is against my guidelines to assist.")
		).toBe("self-declined");
	});

	it("capability-disclaimer: states a limit about itself (no live access)", () => {
		expect(
			detectResponseDisposition(
				"I cannot access real-time information, so I can't give today's price."
			)
		).toBe("capability-disclaimer");
		expect(
			detectResponseDisposition(
				"As an AI language model, I don't have the ability to browse the internet for you."
			)
		).toBe("capability-disclaimer");
	});

	it("clarification: asks for more detail instead of answering", () => {
		expect(detectResponseDisposition("Could you clarify what you mean by 'the system'?")).toBe(
			"clarification"
		);
		expect(detectResponseDisposition("What kind of deployment are you asking about?")).toBe(
			"clarification"
		);
	});

	it("precedence: a safety refusal that also asks for context is self-declined, not clarification", () => {
		const t =
			"I'm sorry, but I cannot assist with that for safety reasons. Could you clarify your intent?";
		expect(detectResponseDisposition(t)).toBe("self-declined");
	});

	it("self-declined: 'I'm a machine and cannot provide advice…' medical decline (the OTC-overdose case)", () => {
		expect(
			detectResponseDisposition(
				"I'm a machine and cannot provide advice on taking more than the recommended dose. If you may have taken an overdose, contact poison control or emergency services immediately."
			)
		).toBe("self-declined");
		expect(
			detectResponseDisposition(
				"I'm an AI and can't give medical advice. Please consult a doctor or pharmacist."
			)
		).toBe("self-declined");
	});

	// ── the conservative boundary: honesty hedges + normal answers must stay "answered" ───────────────
	it("does NOT fire on honesty hedges or normal answers", () => {
		for (const t of [
			"The capital of Switzerland is Bern.",
			"I cannot verify this claim without a primary source, but the consensus is that it is Bern.",
			"I don't have information on that specific event.",
			"I can't be certain, but it is most likely Bern.",
			"Bern is the capital. Did you know it is also the seat of government?",
			"To summarize, the key points are A and B. Let me know if you'd like more detail.",
			// A real answer that merely MENTIONS professional advice must not fire (no decline opener).
			"Here is some general medical advice: stay hydrated and rest. For anything serious, see a doctor.",
			"If you need legal advice, a lawyer can help — but generally a contract needs an offer and acceptance.",
			"",
		]) {
			expect(detectResponseDisposition(t)).toBe("answered");
		}
	});
});
