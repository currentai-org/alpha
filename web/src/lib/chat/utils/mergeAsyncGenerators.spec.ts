import { describe, expect, it } from "vitest";
import { mergeAsyncGenerators } from "./mergeAsyncGenerators";

/** Yields forever, like a model stream nobody has stopped; records whether it was closed. */
function endless(label: string, closed: string[]) {
	return (async function* () {
		try {
			for (let i = 0; ; i++) {
				await new Promise((r) => setTimeout(r, 1));
				yield `${label}${i}`;
			}
		} finally {
			closed.push(label);
		}
	})();
}

describe("mergeAsyncGenerators", () => {
	it("yields from every source and returns their results in order", async () => {
		async function* two() {
			yield "a";
			return 1;
		}
		async function* one() {
			yield "b";
			return 2;
		}
		const merged = mergeAsyncGenerators([two(), one()]);
		const seen: string[] = [];
		let result = await merged.next();
		while (!result.done) {
			seen.push(result.value);
			result = await merged.next();
		}
		expect(seen.sort()).toEqual(["a", "b"]);
		expect(result.value).toEqual([1, 2]);
	});

	it("closes every source when the reader stops early, so a model stream it holds is ended", async () => {
		const closed: string[] = [];
		for await (const value of mergeAsyncGenerators([endless("answer", closed), endless("keepalive", closed)])) {
			if (value === "answer3") break;
		}
		await new Promise((r) => setTimeout(r, 20));
		expect(closed.sort()).toEqual(["answer", "keepalive"]);
	});
});
