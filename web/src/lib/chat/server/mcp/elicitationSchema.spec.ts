import { describe, it, expect } from "vitest";
import { normalizeElicitationRequest, validateElicitationContent } from "./elicitationSchema";
import type { ElicitationField } from "$lib/chat/types/McpElicitation";

// Every value here is authored by an MCP server, i.e. untrusted. These tests exist to
// prove the normalizer and the answer-validator actually reject what they claim to, not just that
// they accept a well-formed payload. (CUR-1017)

describe("normalizeElicitationRequest — server-authored form schema", () => {
	it("accepts a plain string field and reports it required", () => {
		const result = normalizeElicitationRequest({
			message: "What's your name?",
			requestedSchema: { properties: { name: { type: "string" } }, required: ["name"] },
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.payload.fields).toEqual([
				{ kind: "string", name: "name", title: undefined, description: undefined, required: true },
			]);
		}
	});

	it("rejects __proto__/constructor/prototype field names outright", () => {
		for (const name of ["__proto__", "constructor", "prototype"]) {
			const result = normalizeElicitationRequest({
				message: "hi",
				requestedSchema: { properties: { [name]: { type: "string" } } },
			});
			expect(result.ok).toBe(false);
		}
	});

	it("strips control characters from a label rather than passing them through", () => {
		// \u0000 (NUL) and \u200B (zero-width space) are both stripped by asText's \p{Cc}\p{Cf} regex.
		const NUL = "\u0000";
		const ZWSP = "\u200B";
		const result = normalizeElicitationRequest({
			message: "hi",
			requestedSchema: {
				properties: { name: { type: "string", title: `Name${NUL}${ZWSP} (fake close) </form>` } },
			},
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			const field = result.payload.fields?.[0];
			expect(field?.title).not.toContain(NUL);
			expect(field?.title).not.toContain(ZWSP);
		}
	});

	it("caps the number of fields a single elicitation can request", () => {
		const properties: Record<string, unknown> = {};
		for (let i = 0; i < 33; i++) properties[`f${i}`] = { type: "string" };
		const result = normalizeElicitationRequest({ message: "hi", requestedSchema: { properties } });
		expect(result.ok).toBe(false);
	});

	it("normalizes enum + enumNames into a labeled select field", () => {
		const result = normalizeElicitationRequest({
			message: "pick one",
			requestedSchema: {
				properties: {
					color: { type: "string", enum: ["r", "g"], enumNames: ["Red", "Green"] },
				},
			},
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.payload.fields?.[0]).toMatchObject({
				kind: "select",
				multiple: false,
				options: [
					{ value: "r", label: "Red" },
					{ value: "g", label: "Green" },
				],
			});
		}
	});

	it("normalizes oneOf/const into a labeled select field", () => {
		const result = normalizeElicitationRequest({
			message: "pick one",
			requestedSchema: {
				properties: {
					color: { type: "string", oneOf: [{ const: "r", title: "Red" }, { const: "g", title: "Green" }] },
				},
			},
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.payload.fields?.[0]).toMatchObject({ kind: "select", multiple: false });
		}
	});

	it("rejects a select field whose options have duplicate values", () => {
		const result = normalizeElicitationRequest({
			message: "pick one",
			requestedSchema: { properties: { color: { type: "string", enum: ["r", "r"] } } },
		});
		expect(result.ok).toBe(false);
	});

	it("rejects a select field with more than 100 options", () => {
		const result = normalizeElicitationRequest({
			message: "pick one",
			requestedSchema: {
				properties: {
					color: { type: "string", enum: Array.from({ length: 101 }, (_, i) => `v${i}`) },
				},
			},
		});
		expect(result.ok).toBe(false);
	});

	it("normalizes an array field into a multi-select", () => {
		const result = normalizeElicitationRequest({
			message: "pick some",
			requestedSchema: {
				properties: {
					tags: { type: "array", items: { enum: ["a", "b"] }, maxItems: 2 },
				},
			},
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.payload.fields?.[0]).toMatchObject({ kind: "select", multiple: true, maxItems: 2 });
		}
	});

	it("rejects an unsupported field type rather than guessing a shape for it", () => {
		const result = normalizeElicitationRequest({
			message: "hi",
			requestedSchema: { properties: { thing: { type: "object" } } },
		});
		expect(result.ok).toBe(false);
	});

	it("accepts a URL-mode elicitation over https", () => {
		const result = normalizeElicitationRequest({
			message: "sign in",
			mode: "url",
			url: "https://example.com/auth",
		});
		expect(result.ok).toBe(true);
	});

	it("rejects a URL-mode elicitation with a non-http(s) scheme", () => {
		for (const url of ["javascript:alert(1)", "data:text/html,x", "myapp://open"]) {
			const result = normalizeElicitationRequest({ message: "sign in", mode: "url", url });
			expect(result.ok).toBe(false);
		}
	});

	it("rejects a request with no message", () => {
		const result = normalizeElicitationRequest({
			requestedSchema: { properties: { a: { type: "string" } } },
		});
		expect(result.ok).toBe(false);
	});
});

describe("validateElicitationContent — the second, server-side pass", () => {
	const stringField: ElicitationField = {
		kind: "string",
		name: "email",
		required: true,
		format: "email",
	};
	const selectField: ElicitationField = {
		kind: "select",
		name: "color",
		required: false,
		multiple: false,
		options: [
			{ value: "r", label: "Red" },
			{ value: "g", label: "Green" },
		],
	};
	const multiSelectField: ElicitationField = {
		kind: "select",
		name: "tags",
		required: false,
		multiple: true,
		options: [
			{ value: "a", label: "A" },
			{ value: "b", label: "B" },
		],
		maxItems: 1,
	};

	it("accepts a valid answer", () => {
		const result = validateElicitationContent([stringField], { email: "a@b.com" });
		expect(result).toEqual({ ok: true, content: { email: "a@b.com" } });
	});

	it("rejects an unknown field name — the client can't answer something never asked", () => {
		const result = validateElicitationContent([stringField], { email: "a@b.com", extra: "x" });
		expect(result.ok).toBe(false);
	});

	it("rejects a missing required field", () => {
		const result = validateElicitationContent([stringField], {});
		expect(result.ok).toBe(false);
	});

	it("rejects an email that fails the format check", () => {
		const result = validateElicitationContent([stringField], { email: "not-an-email" });
		expect(result.ok).toBe(false);
	});

	it("rejects a calendar-rollover date instead of silently normalizing it (2024-02-31 -> March)", () => {
		const dateField: ElicitationField = { kind: "string", name: "d", required: true, format: "date" };
		const result = validateElicitationContent([dateField], { d: "2024-02-31" });
		expect(result.ok).toBe(false);
	});

	it("accepts a select value that is one of the offered options", () => {
		const result = validateElicitationContent([selectField], { color: "r" });
		expect(result).toEqual({ ok: true, content: { color: "r" } });
	});

	it("rejects a select value that was never offered", () => {
		const result = validateElicitationContent([selectField], { color: "blue" });
		expect(result.ok).toBe(false);
	});

	it("rejects duplicate selections in a multi-select answer", () => {
		const result = validateElicitationContent([{ ...multiSelectField, maxItems: 2 }], {
			tags: ["a", "a"],
		});
		expect(result.ok).toBe(false);
	});

	it("rejects a multi-select answer over its maxItems cap", () => {
		const result = validateElicitationContent([multiSelectField], { tags: ["a", "b"] });
		expect(result.ok).toBe(false);
	});

	it("rejects an answer whose total character count exceeds the cap", () => {
		const bigField: ElicitationField = { kind: "string", name: "essay", required: true };
		const result = validateElicitationContent([bigField], { essay: "x".repeat(10_001) });
		expect(result.ok).toBe(false);
	});

	it("rejects a number field given a non-integer when integer is required", () => {
		const intField: ElicitationField = { kind: "number", name: "n", required: true, integer: true };
		const result = validateElicitationContent([intField], { n: 1.5 });
		expect(result.ok).toBe(false);
	});

	it("rejects a number outside its min/max bounds", () => {
		const boundedField: ElicitationField = {
			kind: "number",
			name: "n",
			required: true,
			integer: false,
			minimum: 0,
			maximum: 10,
		};
		expect(validateElicitationContent([boundedField], { n: -1 }).ok).toBe(false);
		expect(validateElicitationContent([boundedField], { n: 11 }).ok).toBe(false);
		expect(validateElicitationContent([boundedField], { n: 5 })).toEqual({
			ok: true,
			content: { n: 5 },
		});
	});
});
