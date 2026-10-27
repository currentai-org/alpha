import { describe, it, expect } from "vitest";
import { evaluateArithmetic } from "./evaluateArithmetic";

describe("evaluateArithmetic", () => {
	it("evaluates the exact CUR-959 FTE expression", () => {
		expect(evaluateArithmetic("9 + 3*0.5")).toBeCloseTo(10.5, 6);
	});

	it("respects operator precedence and parentheses", () => {
		expect(evaluateArithmetic("(9 + 3) * 0.5")).toBeCloseTo(6, 6);
		expect(evaluateArithmetic("2 + 3 * 4")).toBe(14);
	});

	it("handles unary minus", () => {
		expect(evaluateArithmetic("-5 + 10")).toBe(5);
		expect(evaluateArithmetic("10 - -5")).toBe(15);
	});

	it("handles division, including fractional results", () => {
		expect(evaluateArithmetic("60 / 40")).toBeCloseTo(1.5, 6);
	});

	it("returns null for division by zero", () => {
		expect(evaluateArithmetic("1 / 0")).toBeNull();
	});

	it("returns null for a malformed expression", () => {
		expect(evaluateArithmetic("9 + ")).toBeNull();
		expect(evaluateArithmetic("(9 + 3")).toBeNull();
		expect(evaluateArithmetic("9 3")).toBeNull(); // trailing token after a complete parse
		expect(evaluateArithmetic("")).toBeNull();
	});

	// SAFETY: this is the actual security boundary, not the parser's correctness. Anything the model
	// (via a forced tool call) might smuggle in must be refused by the character
	// whitelist before the parser ever sees it.
	it("refuses anything that is not arithmetic — never eval()", () => {
		expect(evaluateArithmetic("process.exit()")).toBeNull();
		expect(evaluateArithmetic("9 + alert(1)")).toBeNull();
		expect(evaluateArithmetic("`${9+9}`")).toBeNull();
		expect(evaluateArithmetic("9; console.log(1)")).toBeNull();
	});

	it("returns null for a malformed number with two decimal points", () => {
		expect(evaluateArithmetic("1.2.3 + 1")).toBeNull();
	});

	// Models sometimes write Unicode math notation instead of ASCII. Normalizing it keeps the
	// expression from being discarded for a reason that is not a security refusal (CUR-853/958).
	describe("normalizes benign Unicode math notation before the whitelist check", () => {
		it("accepts × as multiplication", () => {
			expect(evaluateArithmetic("10.5 - (2 × 0.5)")).toBeCloseTo(9.5, 6);
		});

		it("accepts ÷ as division", () => {
			expect(evaluateArithmetic("9 ÷ 3")).toBeCloseTo(3, 6);
		});

		it("accepts − (U+2212 minus sign) as subtraction", () => {
			expect(evaluateArithmetic("10 − 4")).toBe(6);
		});

		it("still refuses everything else — normalization doesn't loosen the security boundary", () => {
			expect(evaluateArithmetic("9 × alert(1)")).toBeNull();
			expect(evaluateArithmetic("`${9×9}`")).toBeNull();
		});
	});
	// 500 EUR at 18% a year over 14 months. A power can be written three ways (^, ** and
	// pow); refusing any of them leaves the model to compute by hand. Python gives 39.8617. (CUR-4028)
	describe("evaluates powers written as ^, ** or pow(a, b)", () => {
		it("gives 1.015 to the 14th as 1.23176 in all three notations", () => {
			for (const expr of ["pow(1.015, 14)", "1.015^14", "1.015**14", "(1 + (0.18 / 12))^14", "pow(1 + (0.18 / 12), 14)"]) {
				expect(evaluateArithmetic(expr), expr).toBeCloseTo(1.23176, 5);
			}
		});

		it("gives the loan's monthly payment as 39.8617, the expression www's Large 3 sent", () => {
			expect(
				evaluateArithmetic("500 * (0.18/12) * (1 + (0.18/12))^14 / ((1 + (0.18/12))^14 - 1)")
			).toBeCloseTo(39.8617, 4);
			expect(evaluateArithmetic("500*0.015*1.015**14/(1.015**14-1)")).toBeCloseTo(39.8617, 4);
		});

		it("binds ^ tighter than unary minus and * and right-associates it", () => {
			expect(evaluateArithmetic("-2^2")).toBe(-4);
			expect(evaluateArithmetic("(-2)^2")).toBe(4);
			expect(evaluateArithmetic("2^3^2")).toBe(512);
			expect(evaluateArithmetic("3 * 2^3")).toBe(24);
			expect(evaluateArithmetic("2^-1")).toBe(0.5);
		});

		it("returns null where a power has no finite real value instead of a made-up number", () => {
			expect(evaluateArithmetic("0^-1")).toBeNull();
			expect(evaluateArithmetic("(-8)^(1/3)")).toBeNull();
			expect(evaluateArithmetic("10^400")).toBeNull();
		});

		it("refuses a function not on the list, and a malformed pow call", () => {
			expect(evaluateArithmetic("Math.pow(2, 3)")).toBeNull();
			expect(evaluateArithmetic("power(2, 3)")).toBeNull();
			expect(evaluateArithmetic("pow(2)")).toBeNull();
			expect(evaluateArithmetic("pow 2, 3")).toBeNull();
			expect(evaluateArithmetic("2, 3")).toBeNull();
			expect(evaluateArithmetic("2^")).toBeNull();
			expect(evaluateArithmetic("2 ** * 3")).toBeNull();
		});
	});

	// A benefit of 65% of 1,840, capped at 1,150, plus 42 for each of 2 children. With no min()
	// the cap could not be one expression and the model spent its tool rounds trying. (CUR-4490)
	describe("evaluates capped and bounded sums with min and max", () => {
		it("gives the capped benefit as 1234", () => {
			expect(evaluateArithmetic("min(1840*0.65, 1150) + 42*2")).toBe(1234);
			expect(evaluateArithmetic("min(1840 × 0.65, 1150) + 2 × 42")).toBe(1234);
		});

		it("applies a floor with max and rounds with round", () => {
			expect(evaluateArithmetic("max(200 - 250, 0)")).toBe(0);
			expect(evaluateArithmetic("round(1196.4)")).toBe(1196);
			expect(evaluateArithmetic("round(39.86171, 2)")).toBe(39.86);
		});
	});

	// SAFETY: mathjs's own language reaches far past arithmetic, and older releases escaped their sandbox
	// through it. The tree walk is the boundary; each line here is a node type it must refuse.
	it("refuses assignment, property access, function definitions, matrices, units and implicit multiplication", () => {
		for (const expr of [
			"x = 5",
			"f(x) = x^2",
			"a.b",
			'"abc"',
			"[1, 2, 3]",
			"[1, 2][1]",
			"{a: 1}",
			"5 cm + 2 inch",
			"import({}, {})",
			"evaluate(\"1+1\")",
			"parse(\"1\")",
			"createUnit(\"foo\")",
			"cos.constructor",
			"1 ? 2 : 3",
			"1:3",
			"9 3",
			"2 pi",
			"1; 2",
			"x + 1",
			"true + 1",
		]) {
			expect(evaluateArithmetic(expr), expr).toBeNull();
		}
	});
});
