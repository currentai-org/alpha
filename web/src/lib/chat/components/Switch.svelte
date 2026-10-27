<script lang="ts">
	import { Switch } from "@aipotluck/alpha-ds";
	import { tap } from "$lib/chat/utils/haptics";

	/**
	 * Legacy settings-page API over the design system's `Switch` (Base UI anatomy, bits-ui
	 * behaviour, square brutalist track). `name` still submits with the surrounding form.
	 */
	interface Props {
		checked: boolean;
		name: string;
		// The accessible name, normally the visible text of the row it sits in. Without it a screen
		// reader announced every toggle as `switch "switch"`.
		label?: string;
		size?: "sm" | "md";
		disabled?: boolean;
		"aria-label"?: string;
	}

	let { checked = $bindable(), name, label, size = "md", disabled = false, "aria-label": ariaLabel }: Props = $props();
</script>

<Switch.Root
	bind:checked
	{name}
	{disabled}
	aria-label={label ?? ariaLabel ?? name}
	onCheckedChange={() => tap()}
	class={size === "sm" ? "scale-75" : undefined}
>
	<Switch.Thumb />
</Switch.Root>
