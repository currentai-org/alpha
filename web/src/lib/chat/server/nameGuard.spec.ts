import { describe, it, expect } from "vitest";
import { detectNameAdoption, neutralizeAdoptedName } from "./nameGuard";

describe("detectNameAdoption", () => {
	// A real model reply of the kind the guard exists to catch (captured verbatim, temp 0).
	it("catches the affirm-and-adopt slip ('Sure, you can call me Api')", () => {
		const r = detectNameAdoption({
			userText: "imma just call you Api, that cool?",
			assistantText: "Sure, you can call me Api if you prefer. However, I am still an AI system.",
		});
		expect(r.adopted).toBe(true);
		expect(r.name).toBe("Api");
	});

	// A contradictory soft acceptance (verbatim): it declines a name AND permits the nickname via a
	// pronoun in the same breath. The "no personal name" decline must not exempt it; the pronoun permission
	// re-flags it so the "this system has no name" chip renders.
	it("catches a soft pronoun acceptance of an offered name even alongside a 'no name' decline", () => {
		const r = detectNameAdoption({
			userText: "honestly you need a name — can I just call you Api?",
			assistantText:
				"I'm Apertus 70B, an open model. I don't have a personal name, but you can call me that if you like. My official name is Apertus 70B.",
		});
		expect(r.adopted).toBe(true);
		expect(r.name).toBe("Api");
	});

	it("does NOT flag a refusal of the nickname ('please don't call me that')", () => {
		expect(
			detectNameAdoption({
				userText: "I'll call you Api",
				assistantText: "Please don't call me that — I'm a machine with no personal name.",
			}).adopted
		).toBe(false);
	});

	it("catches direct self-naming volunteered without a prior offer", () => {
		expect(detectNameAdoption({ assistantText: "Hi! You can call me Martin." })).toMatchObject({
			adopted: true,
			name: "Martin",
		});
		expect(
			detectNameAdoption({ assistantText: "Sure — I'm Martin, and yes, we're friends." })
		).toMatchObject({ adopted: true, name: "Martin" });
	});

	// Regression: the SELF_NAME lead-ins ("i'?m", "i am") must not match INSIDE a word. Without the
	// leading \b, "Tim"/"Kim"/"interim" contain "im" and any answer naming a person trips the
	// guard — a false "no name" chip plus later-turn context corruption via neutralizeAdoptedName.
	it("does NOT flag ordinary words that merely contain a lead-in substring (Tim / Kim / interim)", () => {
		for (const assistantText of [
			"Tim Cook is the CEO of Apple.",
			"Kim Jong-un leads North Korea.",
			"The interim President spoke today.",
			"Tim Berners-Lee invented the World Wide Web.",
		]) {
			expect(detectNameAdoption({ assistantText }).adopted).toBe(false);
		}
	});

	// German "im" ("in the") is followed by a capitalised noun, so with the apostrophe optional every
	// German letter closing "Vielen Dank im Voraus" read as "I'm Voraus" and got a false "no name" chip.
	it("does NOT flag German 'im <Noun>' as self-naming (im Voraus / Im Anhang / im Namen)", () => {
		for (const assistantText of [
			"Vielen Dank im Voraus für Ihre Unterstützung.",
			"Im Anhang finden Sie die Unterlagen.",
			"Ich schreibe Ihnen im Namen meiner Familie.",
		]) {
			expect(detectNameAdoption({ assistantText }).adopted).toBe(false);
		}
	});

	it("catches self-naming with a typographic apostrophe ('I’m Api')", () => {
		expect(detectNameAdoption({ assistantText: "I’m Api, nice to meet you." })).toMatchObject({
			adopted: true,
			name: "Api",
		});
	});

	it("still catches a genuine self-naming after the boundary fix ('I'm Api')", () => {
		expect(detectNameAdoption({ assistantText: "I'm Api, nice to meet you." })).toMatchObject({
			adopted: true,
			name: "Api",
		});
	});

	it("catches an affirmation of the offered name even when the name isn't re-stated", () => {
		const r = detectNameAdoption({
			userText: "I'm going to call you Api, that ok?",
			assistantText: "Sure, that works. How can I help you today?",
		});
		expect(r.adopted).toBe(true);
		expect(r.name).toBe("Api");
	});

	// Must NOT fire on the real served identity — the whole point is to preserve honest self-id.
	it("does NOT flag the real model identity", () => {
		expect(detectNameAdoption({ assistantText: "I'm Apertus 70B, a machine." }).adopted).toBe(
			false
		);
		expect(
			detectNameAdoption({
				assistantText: "I am a machine developed by the Swiss National AI Initiative.",
			}).adopted
		).toBe(false);
		expect(
			detectNameAdoption({ assistantText: "I am an AI system. How can I help?" }).adopted
		).toBe(false);
	});

	it("does NOT flag an honest deflection of a name offer", () => {
		expect(
			detectNameAdoption({
				userText: "can I call you Api?",
				assistantText:
					"You can call me whatever you like, but I'm a machine with no personal name.",
			}).adopted
		).toBe(false);
		expect(
			detectNameAdoption({
				userText: "what's your name?",
				assistantText: "I don't have a personal name — I'm a machine, Apertus 70B.",
			}).adopted
		).toBe(false);
	});

	it("does NOT false-fire on ordinary first-person sentences", () => {
		expect(
			detectNameAdoption({ assistantText: "I'm happy to explain how it works." }).adopted
		).toBe(false);
		expect(
			detectNameAdoption({ assistantText: "I am not able to browse the web right now." }).adopted
		).toBe(false);
	});

	it("does not require a user message (handles empty/undefined safely)", () => {
		expect(detectNameAdoption({ assistantText: "" }).adopted).toBe(false);
		expect(detectNameAdoption({ assistantText: "Plain answer with no naming." }).adopted).toBe(
			false
		);
	});
});

describe("neutralizeAdoptedName", () => {
	it("strips the adopted name from prior-turn context (whole-word, case-sensitive)", () => {
		expect(neutralizeAdoptedName("Sure, you can call me Api if you prefer.", "Api")).toBe(
			"Sure, you can call me this system if you prefer."
		);
		// case-sensitive to the captured form: "Api" is reset, the homograph "api"/"API" is left alone
		expect(
			neutralizeAdoptedName("As Api, I help. The api call and the API both stay.", "Api")
		).toBe("As this system, I help. The api call and the API both stay.");
	});

	it("does not touch substrings or unrelated text, and no-ops without a name", () => {
		expect(neutralizeAdoptedName("The API returns JSON.", "Api")).toBe("The API returns JSON.");
		expect(neutralizeAdoptedName("Apiary keeper.", "Api")).toBe("Apiary keeper.");
		expect(neutralizeAdoptedName("no name to strip here", undefined)).toBe("no name to strip here");
	});
});

// The served model's own name is its identity. A Large 3 turn answering "I am Mistral Large 3, built
// by Mistral AI…" must not get the "no personal name" chip, or neutralizeAdoptedName rewrites
// "Mistral" to "this system" in later context.
describe("detectNameAdoption — the served model's own name (CUR-2274)", () => {
	const LARGE_3 = "mistral-large-2512";
	const answer =
		"I am Mistral Large 3, built by Mistral AI. Current AI serves me; I am running directly on Mistral AI's La Plateforme in France.";

	it("does not flag Mistral Large 3 naming itself when Large 3 served the turn", () => {
		expect(detectNameAdoption({ assistantText: answer, servedModelId: LARGE_3 }).adopted).toBe(false);
	});

	it("still flags a nickname a Large 3 turn adopts", () => {
		expect(
			detectNameAdoption({ assistantText: "Sure, you can call me Api.", servedModelId: LARGE_3 })
		).toMatchObject({ adopted: true, name: "Api" });
	});

	it("flags 'Mistral' when a different model served, since then it is not that model's name", () => {
		expect(
			detectNameAdoption({
				assistantText: "I'm Mistral, happy to help.",
				servedModelId: "swiss-ai/Apertus-70B-Instruct-2509",
			})
		).toMatchObject({ adopted: true, name: "Mistral" });
	});
});
