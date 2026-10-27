// The evaluator behind the native `calculate` tool (endpoints/openai/calculateTool.ts, CUR-2273). Its
// input is model output rather than trusted code, so the model is only ever trusted to state an
// expression, never to have computed it.
//
// Mathjs (Apache-2.0) parses and evaluates, in place of a hand-written parser that had no
// min(), so a capped benefit ("65% of 1,840, at most 1,150") could not be written as one expression.
// Its expression language reaches much further than
// arithmetic (assignment, property access, function definitions, matrices, units), and older releases
// had sandbox escapes through exactly those (GHSA-5v89-rwgr-qj6g, GHSA-29qv-4j9f-fjw5, GHSA-jvff-x2qm-6286,
// all fixed in 15.2.0). So the security boundary is ours: the parsed tree is walked before anything is
// evaluated, and any node outside plain arithmetic and the functions below is refused. (CUR-4490)

import { create, all, type MathNode } from "mathjs";

const math = create(all, { number: "number" });

/** The functions an expression may call, by name. */
const FUNCTIONS = new Set(["min", "max", "round", "floor", "ceil", "abs", "sqrt", "pow", "exp", "log", "log10"]);

/** The only names an expression may use that are not calls. */
const CONSTANTS = new Set(["pi", "e"]);

/** Binary and unary operators by mathjs's function name; `mod` covers `%` between two numbers. */
const OPERATORS = new Set(["add", "subtract", "multiply", "divide", "pow", "unaryMinus", "unaryPlus", "mod"]);

// CUR-853/958: the model sometimes writes Unicode math notation instead of ASCII. CUR-4028: `**` is
// the same operator as `^`.
const UNICODE_MATH_OPERATORS: Readonly<Record<string, string>> = {
	"×": "*",
	"÷": "/",
	"−": "-", // U+2212 MINUS SIGN, distinct from the ASCII hyphen-minus
};

function normalizeMathNotation(expr: string): string {
	return expr.replace(/[×÷−]/g, (c) => UNICODE_MATH_OPERATORS[c]).replace(/\*\*/g, "^");
}

/** Whether every node in the tree is arithmetic: numbers, the operators above, parentheses, the
 *  functions above called by name, and the two constants. `9 3` is refused rather than read as 27. */
function isArithmetic(node: MathNode): boolean {
	let ok = true;
	node.traverse((n, _path, parent) => {
		if (!ok) return;
		switch (n.type) {
			case "ConstantNode":
				ok = typeof (n as MathNode & { value: unknown }).value === "number";
				return;
			case "ParenthesisNode":
				return;
			case "OperatorNode": {
				const op = n as MathNode & { fn: string; implicit?: boolean };
				ok = OPERATORS.has(op.fn) && op.implicit !== true;
				return;
			}
			case "FunctionNode": {
				const fn = (n as MathNode & { fn: MathNode }).fn;
				ok = fn.type === "SymbolNode" && FUNCTIONS.has((fn as MathNode & { name: string }).name);
				return;
			}
			case "SymbolNode": {
				// A function's own name is a SymbolNode under its FunctionNode, checked there.
				const isCallee = parent?.type === "FunctionNode" && (parent as MathNode & { fn: MathNode }).fn === n;
				ok = isCallee || CONSTANTS.has((n as MathNode & { name: string }).name);
				return;
			}
			default:
				ok = false;
		}
	});
	return ok;
}

/** Evaluate an arithmetic expression. Never throws; returns null for anything malformed, outside the
 *  allowed arithmetic, or without a real finite value (division by zero, 10^400, (-8)^(1/3)). */
export function evaluateArithmetic(expr: string): number | null {
	const text = normalizeMathNotation(expr).trim();
	if (!text) return null;
	let tree: MathNode;
	try {
		tree = math.parse(text);
	} catch {
		return null;
	}
	if (!isArithmetic(tree)) return null;
	let value: unknown;
	try {
		value = tree.compile().evaluate({});
	} catch {
		return null;
	}
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
