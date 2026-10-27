import { describe, expect, it } from "vitest";
import {
	markupRunawayStart,
	stripEchoedWrapperTail,
	stripMarkupRunaway,
	stripTrailingCloserRun,
} from "./trailingCloserRun";

const ANSWER =
	"According to the attached Northwind Volunteers Travel and Expenses Policy, a taxi is reimbursed " +
	"**up to 37 EUR per trip**, and this applies **only for journeys that start after 22:00**.";
// A model's answer tail with an echoed wrapper closer and a run of closers (CUR-2882), shortened.
const WRECK = ANSWER + " _/document_.]() }}}" + "]}".repeat(120);

describe("stripTrailingCloserRun (CUR-2882)", () => {
	it("cuts the echoed </document> tag and the closer run, keeping the answer above it whole", () => {
		const v = stripTrailingCloserRun(WRECK);
		expect(v.flagged).toBe(true);
		expect(v.cleaned).toBe(ANSWER);
	});

	it("keeps the answer's own full stop when the run starts right after it", () => {
		expect(stripTrailingCloserRun("The cap is 37 EUR.]}]}]}]}").cleaned).toBe("The cap is 37 EUR.");
	});

	it("keeps the answer's own closing emphasis and a paren that closed a real opener", () => {
		expect(stripTrailingCloserRun("It is **up to 37 EUR per trip**.]}]}]}]}").cleaned).toBe(
			"It is **up to 37 EUR per trip**."
		);
		expect(stripTrailingCloserRun("See the policy (section 3)]}]}]}]}").cleaned).toBe(
			"See the policy (section 3)"
		);
	});

	it("keeps a sentence that simply ends on the word document; only the echoed tag goes", () => {
		expect(stripTrailingCloserRun("Please sign the attached document]}]}]}]}").cleaned).toBe(
			"Please sign the attached document"
		);
		expect(stripTrailingCloserRun("The cap is 37 EUR.</document>]}]}]}]}").cleaned).toBe(
			"The cap is 37 EUR."
		);
	});

	it("leaves balanced brackets alone, including JSON written outside a fence", () => {
		const json = 'The shape is {"a": {"b": {"c": [1, 2]}}}';
		expect(stripTrailingCloserRun(json)).toEqual({ cleaned: json, flagged: false, unmatched: 0 });
	});

	it("leaves a smiley or one stray closer at the end alone", () => {
		for (const t of ["Glad that helped :)", "See the note (section 3.2)).", "Done]]"]) {
			expect(stripTrailingCloserRun(t).flagged).toBe(false);
		}
	});

	it("never reads brackets inside a code block, even one ending in a run of closers", () => {
		const code = "Here it is:\n\n```js\nfoo(bar(baz(qux())));\n}}}}}\n```";
		expect(stripTrailingCloserRun(code).flagged).toBe(false);
	});

	// Shape seen on a .txt step with Large 3: runs with no echoed tag, after a sentence stop.
	const ASK = "Would you like help with anything else from the notes?";
	it("cuts a same-line run of backticks and closers after a sentence stop", () => {
		const runaway = ASK + "] }]```}```]```}```" + "]```]```}```".repeat(60) + "``";
		expect(stripTrailingCloserRun(runaway)).toMatchObject({ cleaned: ASK, flagged: true });
		expect(stripTrailingCloserRun(ASK + "```]```")).toMatchObject({ cleaned: ASK, flagged: true });
		expect(stripTrailingCloserRun("It closes at 19:40." + '.">'.repeat(40))).toMatchObject({
			cleaned: "It closes at 19:40.",
			flagged: true,
		});
		expect(stripTrailingCloserRun(ASK + '">')).toMatchObject({ cleaned: ASK, flagged: true });
		expect(stripTrailingCloserRun(ASK + ">")).toMatchObject({ cleaned: ASK, flagged: true });
	});

	it("drops a trailing run of zero-width spaces", () => {
		expect(stripTrailingCloserRun(ASK + "\u200b".repeat(200))).toMatchObject({ cleaned: ASK, flagged: true });
	});

	it("keeps a closing quote, paren or fence that belongs to the answer", () => {
		for (const t of [
			'He asked "why?").',
			'She said "done."',
			"(See section 3.)",
			"Run this:\n\n```sh\nls\n```",
			"The tag is `[x]`.",
			"Is it **19:40**?",
			"Go up one level with `cd ..`.",
			"Run `echo hi.`).",
			'[He said "stop."]',
			"Type `a > b`.",
		])
			expect(stripTrailingCloserRun(t)).toEqual({ cleaned: t, flagged: false, unmatched: 0 });
	});

	it("leaves an answer with no tail untouched", () => {
		expect(stripTrailingCloserRun(ANSWER).flagged).toBe(false);
		expect(stripTrailingCloserRun("").flagged).toBe(false);
	});
});

// A run that interleaves letters
// ("./cite]" over and over): the tail after the last letter is one closer and the trim above
// never fires. What both shapes share is our own wrapper echoed into the answer.
const ECHO_ANSWER =
	"The attached Northwind Volunteers Travel and Expenses Policy states that taxis are reimbursed up to " +
	"37 EUR per trip, and this applies only for journeys that start after 22:00";
const CITE_WRECK =
	ECHO_ANSWER +
	'document name="expenses-policy.pdf" type="application/pdf">./cite[1]/' +
	"./cite]".repeat(10) +
	".";

describe("stripEchoedWrapperTail (CUR-2882)", () => {
	it("cuts our echoed <document> opener and the cite run after it, keeping the answer above it", () => {
		expect(stripTrailingCloserRun(CITE_WRECK).flagged).toBe(false);
		expect(stripEchoedWrapperTail(CITE_WRECK)).toEqual({ cleaned: ECHO_ANSWER, flagged: true });
	});

	it("cuts with the angle brackets intact, and past a second echoed tag", () => {
		const tail = '<document name="a.pdf" type="application/pdf"></document><document name="a.pdf" type="application/pdf">';
		expect(stripEchoedWrapperTail("The cap is 37 EUR." + tail).cleaned).toBe("The cap is 37 EUR.");
	});

	it("keeps every word of prose that follows the tag, and drops only the tag", () => {
		const t =
			'The cap is 37 EUR. document name="a.pdf" type="application/pdf"> It also covers night buses after midnight.';
		expect(stripEchoedWrapperTail(t)).toEqual({
			cleaned: "The cap is 37 EUR. It also covers night buses after midnight.",
			flagged: true,
		});
	});

	it("keeps an answer that opens with the tag, since cutting there would leave nothing", () => {
		expect(stripEchoedWrapperTail('<document name="a.pdf" type="application/pdf">]]').flagged).toBe(false);
	});

	it("needs both attributes we write, and never reads the tag inside code", () => {
		expect(stripEchoedWrapperTail('Name the file document name="a.pdf" ]]]').flagged).toBe(false);
		const code = 'The wrapper looks like `<document name="a.pdf" type="application/pdf">` here.';
		expect(stripEchoedWrapperTail(code).flagged).toBe(false);
	});

	// Live shapes from Large 3 on a .txt turn (CUR-3203).
	const HOURS = "The reading room closes at **19:40** on Thursdays, due to boiler servicing";
	it("cuts a bare <document> echo and the backtick run after it", () => {
		expect(stripEchoedWrapperTail(HOURS + "<document>. </document>.```]```").cleaned).toBe(HOURS + ".");
		const runaway = HOURS + "<document>.```</document>```.``````.```</document>`````````1```.```1```.```1";
		expect(stripEchoedWrapperTail(runaway).cleaned).toBe(HOURS + ".");
	});

	it("drops an empty echoed pair inside the answer and keeps the sentence after it", () => {
		const t = HOURS + '<document name="lakeside-library-hours.txt">. </document>. Is there anything else?';
		expect(stripEchoedWrapperTail(t)).toEqual({ cleaned: HOURS + ". Is there anything else?", flagged: true });
	});

	it("cuts the file name echoed after the last sentence with our closing quote", () => {
		const t = HOURS + '. lakeside-library-hours.txt"].';
		expect(stripEchoedWrapperTail(t)).toEqual({ cleaned: HOURS + ".", flagged: true });
	});

	it("keeps a file name the answer names in its own words, quoted or not", () => {
		for (const t of ['See notes.txt.', 'The file is called "notes.txt".', 'Use `["a.txt"]` as the list.'])
			expect(stripEchoedWrapperTail(t).flagged).toBe(false);
	});

	it("drops tags echoed mid-answer when the model starts the answer over, and the tag run it ends on", () => {
		const t =
			HOURS +
			'<document name="lakeside-library-hours.txt">\n The reading room closes at **19:40** on Thursdays. ' +
			'<document name="lakeside-library-hours.txt">.</document>**.**["lakeside-library-hours.txt"].</document>**.**';
		expect(stripEchoedWrapperTail(t)).toEqual({
			cleaned: HOURS + ". The reading room closes at **19:40** on Thursdays.",
			flagged: true,
		});
	});

	it("cuts a bare <document> after a citation marker, keeping the marker and the full stop (CUR-3212, mozfest PDF step)", () => {
		const t = "It applies only for journeys that start after 22:00 [1]<document>.";
		expect(stripEchoedWrapperTail(t)).toEqual({
			cleaned: "It applies only for journeys that start after 22:00 [1].",
			flagged: true,
		});
	});

	it("keeps a <document> tag written inside a code span (CUR-3212)", () => {
		const t = "Wrap the file in `<document>` and close it with `</document>`.";
		expect(stripEchoedWrapperTail(t)).toEqual({ cleaned: t, flagged: false });
	});

	// Shape seen on .txt turns (CUR-3218).
	it("cuts a numbered <document_1> echo and the gibberish run after it", () => {
		const t = HOURS + '<document_1>. </document_1>"]}]}```]]}```jsonزراء1<document_1>.```]]}```';
		expect(stripEchoedWrapperTail(t)).toEqual({ cleaned: HOURS, flagged: true });
	});

	// The suffix is hex, not a count (CUR-3218).
	it("cuts a hex-suffixed <document_116841d6> echo and keeps the sentence's full stop", () => {
		const said =
			"The reading room at Lakeside Library closes at **19:40 on Thursdays**. This is noted in the internal document as an exception due to boiler servicing";
		expect(stripEchoedWrapperTail(said + "<document_116841d6>.")).toEqual({ cleaned: said + ".", flagged: true });
		expect(stripEchoedWrapperTail(said + ".</document_116841d6>")).toEqual({ cleaned: said + ".", flagged: true });
	});

	it("drops our closer and a </div> wrapped in backticks, keeping the sentence repeated after them", () => {
		const said = "The reading room closes at **19:40 on Thursdays**. This is noted in the document you shared.";
		const again = "The reading room closes at **19:40 on Thursdays**, as mentioned in the document.";
		const junk = "```</document>```.```</div>```";
		expect(stripEchoedWrapperTail(said + junk + "\n\n" + again + junk)).toEqual({
			cleaned: said + " " + again,
			flagged: true,
		});
	});

	it("still never reads a code span that shows a tag with attributes, or code with words in it", () => {
		for (const t of ["Close it with `</div>` and `<p class=\"x\">` tags.", "Run `make </dev/null` first."])
			expect(stripEchoedWrapperTail(t).flagged).toBe(false);
	});

	it("keeps a quoted file-name list that no echoed tag comes before", () => {
		const t = 'Your files are ["notes.txt"]. Ask me about either one.';
		expect(stripEchoedWrapperTail(t)).toEqual({ cleaned: t, flagged: false });
	});

	it("never reads prose about a document, or a tag word with no brackets, as the echo", () => {
		const prose = "Attach the document and I will read it. The document says 19:40.";
		expect(stripEchoedWrapperTail(prose).flagged).toBe(false);
		expect(stripEchoedWrapperTail("Read the document name list ]]]").flagged).toBe(false);
	});

	it("never reads HTML attributes in an answer as our opener with its tag word lost (CUR-3212)", () => {
		for (const t of [
			'Load it with <script src="app.js" type="text/javascript"></script> at the end.',
			'Set name="report.pdf" in the form and the browser sends it as a file.',
		])
			expect(stripEchoedWrapperTail(t).flagged).toBe(false);
	});

	it("keeps the model's own answer when a lead-in puts it inside our wrapper, and drops only the tags (CUR-3212 review)", () => {
		const body = "Taxis are reimbursed up to 37 EUR per trip, and only after 22:00. Trains are covered in full.";
		for (const lead of ["Here is a summary of the policy:", "Here is a summary of the policy"]) {
			const { cleaned } = stripEchoedWrapperTail(
				`${lead}\n name="expenses-policy.pdf" type="application/pdf">\n${body}\n</document>`
			);
			expect(cleaned).toContain(body);
			expect(cleaned).not.toMatch(/type="application\/|\/document/);
		}
	});

	it("never ends a trimmed answer on a full stop it added, or on nothing", () => {
		const { cleaned } = stripEchoedWrapperTail(
			'Two limits apply:\n\n- **37 EUR** per trip\n- journeys after **22:00**\n name="a.pdf" type="application/pdf">\nTaxis.\n</document>'
		);
		expect(cleaned).toBe("Two limits apply:\n\n- **37 EUR** per trip\n- journeys after **22:00**");
	});

	it("leaves an answer with no echoed tag untouched", () => {
		expect(stripEchoedWrapperTail(ANSWER)).toEqual({ cleaned: ANSWER, flagged: false });
		expect(stripEchoedWrapperTail("").flagged).toBe(false);
	});
});

// Every echo shape seen live, crossed with answer endings, through both trims in the order
// honestyStream.ts runs them. One test per shape cannot see a shape breaking another's answer.
describe("echoed-wrapper trims, every live shape × every answer ending (CUR-3203, CUR-3212)", () => {
	const clean = (t: string) => stripEchoedWrapperTail(stripTrailingCloserRun(t).cleaned).cleaned;
	const outsideCode = (t: string) => t.replace(/`[^`\n]*`/g, "");
	const ANSWERS = [
		ANSWER,
		"It applies only for journeys that start after 22:00 [1].",
		"The reading room closes at **19:40** on Thursdays.",
		"I read the document you attached. Its first line is the title.",
		"The tag is `<document>`, and the file closes with `</document>`.",
		"Two limits apply:\n\n- **37 EUR** per trip\n- journeys after **22:00**",
	];
	const TAILS = [
		"<document>.",
		"</document>",
		"<document>. </document>.```]```",
		'<document name="lakeside-library-hours.txt">. </document>.',
		'document name="expenses-policy.pdf" type="application/pdf">./cite[1]/./cite]./cite]',
		' lakeside-library-hours.txt"].',
		" _/document_.]() }}}" + "]}".repeat(40),
		"] }]```}```" + "]```]```}```".repeat(20),
		"```]```",
		// Large 3, a PDF turn asked to cite its sources (CUR-3212): the tag word is
		// gone, and the whole wrapper comes back with the document's text inside it.
		' name="expenses-policy.pdf" type="application/pdf">\nNorthwind Volunteers: Travel and Expenses Policy\n' +
			"Taxis are reimbursed up to 37 EUR per trip, and only for journeys that start after 22:00.\n</document.",
		' name="expenses-policy.pdf" type="application/pdf".',
		'="expenses-policy.pdf" type="application/pdf".',
	];
	const LEFTOVER = /<\/?document|\/document|document name=|\.txt"\]|type="application\/|Taxis are reimbursed/i;

	it.each(ANSWERS)("leaves a clean answer exactly as written: %#", (a) => {
		expect(clean(a)).toBe(a);
	});

	for (const [i, a] of ANSWERS.entries()) {
		it.each(TAILS)(`answer ${i} + tail %#: no tag is left and every word of the answer stays`, (tail) => {
			const out = clean(a + tail);
			expect(outsideCode(out)).not.toMatch(LEFTOVER);
			expect(out.replace(/[.\s]+$/, "")).toBe(a.replace(/[.\s]+$/, ""));
		});
	}

	it.each(ANSWERS.slice(0, 4))("drops an empty pair between two sentences and keeps both: %#", (a) => {
		const out = clean(a + ' <document name="a.txt">. </document>. Is there anything else?');
		expect(outsideCode(out)).not.toMatch(LEFTOVER);
		expect(out).toContain(a.replace(/[.\s]+$/, ""));
		expect(out).toMatch(/Is there anything else\?$/);
	});
});

// Large 3 on cited PDF answers: the answer ends "after 22:00**" with no
// full stop. The model wrote its stop after our closer (`</document.`), and the whole-wrapper cut
// dropped it with the wrapper; the matrix above strips trailing stops before comparing, so it can't see it.
it("keeps the full stop written after our closer when it cuts a whole echoed wrapper from a bold ending (CUR-3212)", () => {
	const answer = "The cap is **37 EUR per trip**, and it applies **only for journeys that start after 22:00**";
	const wrapper =
		' name="expenses-policy.pdf" type="application/pdf">\nTaxis are reimbursed up to 37 EUR per trip.\n</document.';
	expect(stripEchoedWrapperTail(answer + wrapper).cleaned).toBe(answer + ".");
	// A stop already before the wrapper is not doubled.
	expect(stripEchoedWrapperTail(answer + "." + wrapper).cleaned).toBe(answer + ".");
	// No stop anywhere: nothing is invented.
	expect(stripEchoedWrapperTail(answer + wrapper.slice(0, -1)).cleaned).toBe(answer);
});

it("drops a follow-up of two words or fewer after an echoed tag: the remainder threshold reads it as markup (known trade, CUR-3203)", () => {
	const out = stripEchoedWrapperTail('The cap is 37 EUR.<document name="a.txt">. </document>. Anything else?').cleaned;
	expect(out).toBe("The cap is 37 EUR.");
});

describe("stripMarkupRunaway (CUR-3302)", () => {
	const FIRST = "No, I don't remember what you told me last time. Each message is processed on its own.";
	const SECOND =
		'The song *"Remember What I Told You to Forget"* is by the band **Tavares** [1][2]. If you meant a ' +
		"different work, say which one. **[1][2]**";
	// The shape Mistral Large 3 writes, shortened: a Hermes tool-call tag, a real
	// answer, then runs of backticks and closers with apologies and restarts between them.
	const WRECK =
		FIRST +
		" ------<function=calculate>\n</function>------\n\n\n" +
		SECOND +
		".```}".repeat(40) +
		" Apologies for the formatting artifacts above. Final Answer: the song is by Tavares." +
		") ```.}".repeat(20) +
		"(Stopped at the length limit.)";

	it("cuts at the first run and drops the tool-call tag, keeping both answers and the full stop", () => {
		const v = stripMarkupRunaway(WRECK);
		expect(v.flagged).toBe(true);
		expect(v.cleaned).toBe(`${FIRST}\n\n${SECOND}.`);
	});

	it("drops a tool-call tag written at the very end, with nothing put in its place", () => {
		expect(stripMarkupRunaway(`${FIRST} ------<function=calculate>\n</function>------`).cleaned).toBe(FIRST);
	});

	it("leaves a fenced code block that closes many brackets alone", () => {
		const code = "Here it is:\n\n```js\nf(g(h([{ a: [{ b: [1] }] }])));\n" + "})]);\n".repeat(10) + "```\n\nDone.";
		expect(stripMarkupRunaway(code)).toEqual({ cleaned: code, flagged: false });
	});

	it("leaves an ellipsis, blank lines and a few closers alone: a run needs twelve backticks or closers", () => {
		const text = `Wait for it${".".repeat(40)} done.\n\n\n\n(see [1])]}) and that is all.`;
		expect(stripMarkupRunaway(text)).toEqual({ cleaned: text, flagged: false });
	});

	it("does not cut when no answer text comes before the run", () => {
		const text = "```}".repeat(20);
		expect(stripMarkupRunaway(text).cleaned).toBe(text);
	});
});

describe("markupRunawayStart (CUR-3302)", () => {
	it("points at a tool tag's opening before its closing tag has streamed", () => {
		const text = "Each message stands alone. ------<function=calcu";
		expect(markupRunawayStart(text)).toBe(text.indexOf(" ------"));
	});

	it("points at the first run of backticks and closers after the answer", () => {
		const text = "The song is by Tavares." + "```}".repeat(12) + " (Note: artifacts.)";
		expect(markupRunawayStart(text)).toBe(text.indexOf(".```"));
	});

	it("holds nothing back for closers inside a closed code fence", () => {
		const nested = "{\n" + "  ".repeat(1) + "[[[[[[[[[[[[[[\n" + "]]]]]]]]]]]]]] } } } } } } } } } } } } }\n";
		const text = "Here is the config:\n```json\n" + nested + "```\nThat is all.";
		expect(markupRunawayStart(text)).toBeNull();
	});
});

// An agent answer carrying a 6 KB markdown file in a fence must not freeze an instance: the stream screen
// runs markupRunawayStart on the whole text once per chunk, and a tag regex that costs seconds per call on
// the blank run blankCode makes of a fence is too slow (CUR-4006). The bound leaves room for a slow CI
// runner and none for that.
describe("markupRunawayStart stays linear on a long code block (CUR-4006)", () => {
	const fileLines = Array.from({ length: 200 }, (_, i) => `- Item ${i}: a line of the saved file, indented.`);
	const fence = "```markdown\n" + fileLines.join("\n");
	const closed = "Here is the file I saved:\n\n" + fence + "\n```\n\nreceipt abc123";
	const open = "Here is the file I saved:\n\n" + fence;

	it("returns within 250 ms on a 12k-char answer with a closed fence", () => {
		const text = closed.repeat(Math.ceil(12_000 / closed.length));
		const t0 = performance.now();
		expect(markupRunawayStart(text)).toBeNull();
		expect(performance.now() - t0).toBeLessThan(250);
	});

	it("returns within 250 ms on a 12k-char answer whose fence is still streaming", () => {
		const text = closed.repeat(Math.ceil(12_000 / closed.length)) + open;
		const t0 = performance.now();
		expect(markupRunawayStart(text)).toBeNull();
		expect(performance.now() - t0).toBeLessThan(250);
	});

	it("still finds a tag written after the long fence", () => {
		const text = closed.repeat(3) + "\n\n ------<function=calculate>";
		expect(markupRunawayStart(text)).toBe(text.lastIndexOf("receipt abc123") + "receipt abc123".length);
	});
});

describe("a tool tag shown as code is the answer, not a runaway (CUR-3302)", () => {
	const TAG = "<function=calculate></function>";

	it("keeps a tag quoted in inline code and in a fence", () => {
		const inline = `The text \`${TAG}\` marks a tool call.`;
		expect(stripMarkupRunaway(inline)).toEqual({ cleaned: inline, flagged: false });
		const fenced = `Written like this:\n\n\`\`\`\n${TAG}\n\`\`\`\n\nThat is all.`;
		expect(stripMarkupRunaway(fenced)).toEqual({ cleaned: fenced, flagged: false });
	});

	it("still drops a tag written on a bare line", () => {
		expect(stripMarkupRunaway(`It was. ------${TAG}------ The song.`).cleaned).not.toContain("<function=");
	});

	it("drops a tag after a fence the answer never closes: at the end, an open fence is the runaway's", () => {
		expect(stripMarkupRunaway(`The answer.\n\`\`\`\n<function=calculate>\n</function>`).cleaned).not.toContain(
			"<function="
		);
	});

	it("holds nothing back for a tag in inline code, a closed fence, or a fence still streaming", () => {
		expect(markupRunawayStart(`The text \`<function=calc\` marks`)).toBeNull();
		expect(markupRunawayStart(`Like this:\n\`\`\`\n${TAG}\n\`\`\`\nDone.`)).toBeNull();
		expect(markupRunawayStart(`Like this:\n\`\`\`\n<function=get_weather>{"city": "Be`)).toBeNull();
	});
});
