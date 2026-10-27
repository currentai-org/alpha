// Which way a block of text reads. Arabic, Urdu and Pashto answers were laid out left to
// right because nothing carried a direction.
//
// This counts letters rather than taking the first one, which is what dir="auto" does. The first-letter
// rule lays out an Arabic answer that opens with "AI Potluck" left to right, and answers about the
// product open with its name often enough to matter. A block reads
// right to left when right-to-left letters outnumber the rest, so a Latin name inside Arabic stays an
// embedded run and an English sentence with one Arabic word stays left to right. Inline code is not
// counted, since it is left-to-right text by nature and says nothing about the prose around it. (CUR-1917)

const RIGHT_TO_LEFT_LETTER =
	/\p{Script=Arabic}|\p{Script=Hebrew}|\p{Script=Syriac}|\p{Script=Thaana}|\p{Script=Nko}/u;

export type TextDirection = "rtl" | "ltr" | "auto";

/** "auto" when the text has no letters at all, so the element inherits its parent's direction. */
export function textDirection(text: string): TextDirection {
	let rightToLeft = 0;
	let other = 0;
	for (const [letter] of text.matchAll(/\p{L}/gu)) {
		if (RIGHT_TO_LEFT_LETTER.test(letter)) rightToLeft++;
		else other++;
	}
	if (rightToLeft === 0 && other === 0) return "auto";
	return rightToLeft > other ? "rtl" : "ltr";
}

/** The same decision for rendered HTML: markup, entities and inline code are left out of the count. */
export function htmlTextDirection(html: string): TextDirection {
	return textDirection(
		html
			.replace(/<code[\s>][\s\S]*?<\/code>/g, " ")
			.replace(/<[^>]*>/g, " ")
			.replace(/&[#\w]+;/g, " ")
	);
}
