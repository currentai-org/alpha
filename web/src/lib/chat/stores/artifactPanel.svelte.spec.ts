import { beforeEach, describe, expect, it } from "vitest";
import { artifactPanel } from "$lib/chat/stores/artifactPanel.svelte";

describe("artifactPanel.openArtifact start tab (CUR-3187)", () => {
	beforeEach(() => artifactPanel.reset());

	it("opens on the code tab when asked, so a shared artifact's script does not run until the viewer picks Preview", () => {
		artifactPanel.openArtifact("a1", null, "code");
		expect(artifactPanel.open).toBe(true);
		expect(artifactPanel.tab).toBe("code");
	});

	it("still opens on Preview by default, for a person's own artifact", () => {
		artifactPanel.openArtifact("a1");
		expect(artifactPanel.tab).toBe("preview");
	});

	it("keeps the viewer's own tab choice when the same artifact is opened again", () => {
		artifactPanel.openArtifact("a1", null, "code");
		artifactPanel.selectTab("preview");
		artifactPanel.openArtifact("a1", null, "code");
		expect(artifactPanel.tab).toBe("preview");
	});
});
