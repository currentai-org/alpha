import { describe, expect, it } from "vitest";
import { ApiError, apiErrorMessage } from "./APIClient";

describe("apiErrorMessage (CUR-2822)", () => {
	it("returns the server's own sentence from an error() body, never the JSON around it", () => {
		const err = new ApiError(502, { message: "Nothing was cleared. Please try again." });
		expect(apiErrorMessage(err, "fallback")).toBe("Nothing was cleared. Please try again.");
	});

	it("falls back when the body has no usable message, or the error is not an ApiError", () => {
		expect(apiErrorMessage(new ApiError(500, { detail: "x" }), "fallback")).toBe("fallback");
		expect(apiErrorMessage(new ApiError(500, { message: "" }), "fallback")).toBe("fallback");
		expect(apiErrorMessage(new ApiError(500, "plain text body"), "fallback")).toBe("fallback");
		expect(apiErrorMessage(new Error('{"message":"not from the API"}'), "fallback")).toBe("fallback");
	});
});
