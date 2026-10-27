import { describe, expect, it } from "vitest";
import {
	insertLegacyConversation,
	insertLinearBranchConversation,
	insertSideBranchesConversation,
} from "./treeHelpers";

describe("inserting conversations", () => {
	it("should insert a legacy conversation", async () => {
		const id = await insertLegacyConversation();
		expect(id).toBeDefined();
	}, 30000);

	it("should insert a linear branch conversation", async () => {
		const id = await insertLinearBranchConversation();
		expect(id).toBeDefined();
	}, 30000);

	it("should insert a side branches conversation", async () => {
		const id = await insertSideBranchesConversation();
		expect(id).toBeDefined();
	}, 30000);
});
