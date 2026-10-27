import { describe, it, expect } from "vitest";
import superjson from "superjson";
import { superjsonResponse } from "./superjsonResponse";

// The bug this file exists to prevent is a TYPE bug with a runtime cost, so the load-bearing
// assertion here is the `@ts-expect-error` below, not any of the runtime expectations.
//
// `superjson.stringify(somePromise)` returns `{}`. It does not throw and it does not warn. So a
// handler that forgets `await` answers HTTP 200 with an empty body, and every field the caller asked
// for is simply missing, which at runtime looks like absent data, not like an error.
//
// A runtime guard cannot fix it. By the time `superjsonResponse` has the value there is nothing
// useful to do with a Promise except await it, and awaiting it silently would make an async handler
// LOOK correct while hiding the missing `await` from the next reader. So the contract is enforced in
// the type, and this spec is where that enforcement is proven to still exist.
describe("superjsonResponse — rejects a Promise at the type level (CUR-255)", () => {
	it("REFUSES to compile when handed an un-awaited value", () => {
		const later = async () => ({ flags: { a: true } });

		// If this line ever stops being a type error, TypeScript reports the directive as unused and
		// `pnpm check` goes red — so this guard cannot rot into a no-op. That is the whole design:
		// deleting the NotPromise<T> constraint breaks this file rather than silently widening the API.
		// @ts-expect-error superjsonResponse must not accept a Promise — see the block comment above
		superjsonResponse(later());

		// The awaited form is the one that should compile, and it does.
		expect(true).toBe(true);
	});

	it("serializes an awaited value to the superjson wire format the client expects", async () => {
		const later = async () => ({ flags: { a: true }, when: new Date("2026-08-06T00:00:00.000Z") });
		const res = superjsonResponse(await later());

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/json");

		// superjson, not JSON — the Date must survive as a Date, which is why this helper exists at all.
		const parsed = superjson.parse<{ flags: { a: boolean }; when: Date }>(await res.text());
		expect(parsed.flags).toEqual({ a: true });
		expect(parsed.when).toBeInstanceOf(Date);
	});

	it("still honours caller-supplied status and headers", () => {
		const res = superjsonResponse({ ok: false }, { status: 404, headers: { "x-probe": "1" } });
		expect(res.status).toBe(404);
		expect(res.headers.get("x-probe")).toBe("1");
		expect(res.headers.get("Content-Type")).toBe("application/json");
	});
});
