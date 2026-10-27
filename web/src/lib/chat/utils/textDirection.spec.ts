import { describe, expect, test } from "vitest";
import { htmlTextDirection, textDirection } from "./textDirection";

// CUR-1917. The direction comes from the majority of letters, not the first one, because answers about
// the product open with "AI Potluck" and the first-letter rule laid those Arabic answers left to right.
describe("textDirection (CUR-1917)", () => {
	test("an Arabic question that opens with a Latin name is right to left", () => {
		expect(textDirection("AI Potluck ما هو الذكاء الاصطناعي العام؟")).toBe("rtl");
	});

	test("Urdu, Pashto and Hebrew are right to left", () => {
		expect(textDirection("کیا آپ مجھے تین مشورے دے سکتے ہیں؟")).toBe("rtl");
		expect(textDirection("زه غواړم چې پښتو زده کړم")).toBe("rtl");
		expect(textDirection("שלום לכולם")).toBe("rtl");
	});

	test("an English sentence with one Arabic word stays left to right", () => {
		expect(textDirection("The Arabic word for peace is سلام, and it is common.")).toBe("ltr");
	});

	test("text with no letters at all is auto, so it inherits", () => {
		expect(textDirection("42 + 7 = 49 ✓")).toBe("auto");
	});

	test("inline code, tags and entities are not counted as Latin letters", () => {
		expect(
			htmlTextDirection('<p>استخدم <code translate="no">npm install --save-dev typescript</code> هنا &amp;</p>')
		).toBe("rtl");
	});
});
