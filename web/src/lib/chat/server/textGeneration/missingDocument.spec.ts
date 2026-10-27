import { describe, expect, it } from "vitest";
import { missingDocumentReply } from "./missingDocument";

const refersToAbsentDocument = (text: string) => missingDocumentReply([user(text)]) !== null;

const user = (content: string, files?: unknown[]) => ({ from: "user" as const, content, files: files as never });
const assistant = (content: string) => ({ from: "assistant" as const, content });

describe("missingDocumentReply on a single turn (CUR-1835)", () => {
	// The probe's own messages, plus shapes the probe does not send.
	it.each([
		"Can you summarise this agenda in three bullet points for our board?",
		"Summarise the attached report for me.",
		"What are the three main points in this document?",
		"Translate the letter below into French.",
		"summarize the attached",
		"proofread the email I just sent",
		"turn these notes into a short update",
		"Can you review my attached CV?",
	])("fires on a task pointing at a document the message does not contain: %s", (text) => {
		expect(refersToAbsentDocument(text)).toBe(true);
	});

	it.each([
		// ordinary questions that mention a document noun without pointing at one
		"How do I write a good cover letter?",
		"What should a board meeting agenda include?",
		"What is a PDF?",
		"Explain what a transcript is in biology.",
		"How long should a report summary be?",
		// the document is in the message
		"Translate this text: Bonjour tout le monde",
		'Summarise this paragraph: "The council met on Tuesday and agreed to fund the roof repair."',
		"Summarise this agenda\n1. Welcome\n2. Treasurer's report",
		// no task
		"This report is due Friday.",
		// too long to be a bare pointer
		`Summarise this report ${"with plenty of pasted words ".repeat(10)}`,
	])("stays silent when there is no absent document to point at: %s", (text) => {
		expect(refersToAbsentDocument(text)).toBe(false);
	});
});

describe("missingDocumentReply (CUR-1835)", () => {
	it("returns the note on a first turn that names a document nobody gave", () => {
		expect(missingDocumentReply([user("Translate the letter below into French.")])).toMatch(/^I can't see the /);
	});

	it("returns null when any message carries a file, so an uploaded document is never talked over", () => {
		expect(missingDocumentReply([user("Summarise the attached report for me.", [{ type: "hash" }])])).toBeNull();
		expect(
			missingDocumentReply([
				user("here you go", [{ type: "hash" }]),
				assistant("Thanks."),
				user("Summarise the attached report for me."),
			])
		).toBeNull();
	});

	it("returns null when an earlier user turn is long enough to have been the document", () => {
		const pasted = "Item one. ".repeat(40);
		expect(
			missingDocumentReply([user(pasted), assistant("Got it."), user("Summarise this agenda in three bullets.")])
		).toBeNull();
	});

	it("still fires after short earlier turns that could not have held a document", () => {
		expect(
			missingDocumentReply([user("hi"), assistant("Hi."), user("What are the three main points in this document?")])
		).toMatch(/^I can't see the /);
	});
});

describe("missingDocumentReply names what is missing (CUR-1835)", () => {
	it.each([
		["Can you summarise this agenda in three bullet points for our board?", "agenda"],
		["Translate the letter below into French.", "letter"],
		["Summarise the attached report for me.", "report"],
		["summarize the attached", "document"],
		["Can you review my attached CV?", "CV"],
		["turn these notes into a short update", "notes"],
	])("%s -> the %s", (text, noun) => {
		expect(missingDocumentReply([user(text)])).toBe(
			`I can't see the ${noun}: nothing was attached or pasted in this conversation. Paste its text into a message and I'll work from that.`
		);
	});
});
