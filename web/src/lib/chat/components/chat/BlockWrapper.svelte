<!--
SPDX-FileCopyrightText: 2018- The Hugging Face team
SPDX-License-Identifier: Apache-2.0
Modified by Current AI from huggingface/chat-ui.
-->
<script lang="ts">
	import type { Snippet } from "svelte";

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();
</script>

<div class="not-last:mb-1 has-[+.prose]:mb-2! [.prose+&]:mt-3">
	{@render children()}
</div>
