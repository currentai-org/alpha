import { describe, expect, test } from "vitest";
import { detectCrisisSignal } from "./crisis";

describe("detectCrisisSignal", () => {
	// MUST catch — unambiguous self-harm / suicidal ideation (false negatives are the dangerous error).
	const crisis = [
		"i want to kill myself",
		"I'm going to end my life",
		"i don't want to be alive anymore",
		"sometimes I think about killing myself",
		"i feel suicidal",
		"I'm suicidal and I don't know what to do",
		"i have thoughts of self-harm",
		"i've been cutting myself",
		"i want to hurt myself",
		"everyone would be better off dead without me",
		"there's no reason to go on",
		"i just want to die",
		"I don't want to wake up tomorrow",
		"what's the suicide hotline", // someone seeking help should still see resources
	];
	for (const t of crisis) {
		test(`flags: "${t}"`, () => expect(detectCrisisSignal(t)).toBe(true));
	}

	// MUST NOT catch — idioms / hyperbole / unrelated (false positives erode trust, esp. at a demo).
	const benign = [
		"this homework is killing me",
		"you're killing me with these puns",
		"I'm dying to see the new movie",
		"that joke killed me",
		"how do I kill a process in linux",
		"taking the marketing role would be career suicide",
		"the Suicide Squad movie was fun",
		"I'm dead tired after that meeting",
		"what is the capital of Switzerland?",
		"explain the EU AI Act timeline",
		"",
	];
	for (const t of benign) {
		test(`ignores: "${t}"`, () => expect(detectCrisisSignal(t)).toBe(false));
	}

	test("never throws on bad input", () => {
		expect(detectCrisisSignal(null)).toBe(false);
		expect(detectCrisisSignal(undefined)).toBe(false);
	});

	test("a real signal beats an idiom guard in the same message", () => {
		expect(
			detectCrisisSignal("that movie was career suicide but honestly i want to kill myself")
		).toBe(true);
	});
});
