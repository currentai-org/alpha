// Single source of truth for how a linked-auth provider is labeled and iconified. Was
// duplicated inline in account/+page.svelte; the workspace zero-org identity view needs the exact
// same mapping (a provider badge next to your name/email) and a second copy would drift the moment
// either page's provider list changes without the other. (CUR-1175)
import RiGoogleFill from "~icons/ri/google-fill";
import RiGithubFill from "~icons/ri/github-fill";
import RiRobotLine from "~icons/ri/robot-line";
import RiLinkM from "~icons/ri/link-m";

export const PROVIDER_META: Record<string, { label: string; Icon: typeof RiGoogleFill }> = {
	google: { label: "Google", Icon: RiGoogleFill },
	github: { label: "GitHub", Icon: RiGithubFill },
	huggingface: { label: "Hugging Face", Icon: RiRobotLine },
};
export const LINKABLE_PROVIDERS = ["google", "github", "huggingface"] as const;

export function providerMeta(providerId: string) {
	return PROVIDER_META[providerId] ?? { label: providerId, Icon: RiLinkM };
}
