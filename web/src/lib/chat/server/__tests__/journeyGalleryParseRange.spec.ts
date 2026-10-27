import { describe, expect, it } from "vitest";
import { parseRange } from "../journeyGallery";

// The video route must answer Range requests, or Chrome cannot seek and every
// tile previews a blank first frame. These pin the
// Range forms Chrome sends when a tile starts at `#t=1.5`. (CUR-1646)
describe("parseRange — the byte range a gallery video request asks for", () => {
	it("serves the whole file when no range is asked for", () => {
		expect(parseRange(null, 1000)).toBeNull();
		expect(parseRange("", 1000)).toBeNull();
	});

	it("reads the open-ended form Chrome sends first", () => {
		expect(parseRange("bytes=0-", 1000)).toEqual({ start: 0, end: 999 });
		expect(parseRange("bytes=400-", 1000)).toEqual({ start: 400, end: 999 });
	});

	it("clamps an end past the file to its last byte", () => {
		expect(parseRange("bytes=10-5000", 1000)).toEqual({ start: 10, end: 999 });
	});

	it("reads the suffix form as the last N bytes", () => {
		expect(parseRange("bytes=-200", 1000)).toEqual({ start: 800, end: 999 });
	});

	it("calls a start past the end unsatisfiable rather than serving an empty or whole file", () => {
		expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
		expect(parseRange("bytes=500-100", 1000)).toBe("unsatisfiable");
	});

	it("serves the whole file for a multi-range or malformed header, which it does not support", () => {
		expect(parseRange("bytes=0-10,20-30", 1000)).toBeNull();
		expect(parseRange("items=0-10", 1000)).toBeNull();
	});
});
