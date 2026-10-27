import { describe, expect, it } from "vitest";
import { parsePositiveInt } from "./client";

describe("parsePositiveInt", () => {
	it("returns the fallback for undefined, blank, and whitespace", () => {
		expect(parsePositiveInt(undefined, 1)).toBe(1);
		expect(parsePositiveInt("", 1)).toBe(1);
		expect(parsePositiveInt("   ", 1)).toBe(1);
	});

	it("returns the fallback for zero, negative, and non-numeric values", () => {
		expect(parsePositiveInt("0", 1)).toBe(1);
		expect(parsePositiveInt("-3", 5)).toBe(5);
		expect(parsePositiveInt("nope", 7)).toBe(7);
		expect(parsePositiveInt("Infinity", 2)).toBe(2);
	});

	it("accepts positive integers and floors decimals", () => {
		expect(parsePositiveInt("1", 9)).toBe(1);
		expect(parsePositiveInt("12", 1)).toBe(12);
		expect(parsePositiveInt("3.9", 1)).toBe(3);
	});
});
