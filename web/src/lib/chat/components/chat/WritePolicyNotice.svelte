<script lang="ts">
	import RiLockLine from '~icons/ri/lock-line';
	import AnswerNote from './AnswerNote.svelte';
	import { page } from "$app/state";

	// Write-permission advisory (CUR-471): shown when the agent service resolved this account's writes
	// to deny_writes for the turn — most often a `staged`-mode account still accruing trust. The model
	// gets its own explanation via a server-injected prompt note (agent-service's belt to this chip's
	// suspenders); this chip is the signal that stays true regardless of whether the model chose to say
	// anything, and it's the ONLY signal at all for a denied terminal/code_execution request — CUR-217's
	// gating removes those tools from the toolset before the session starts rather than denying the
	// call, so there's no tool_result frame to narrate a refusal from the way write_file/patch get one.
	interface Props {
		tier: "uniform" | "new" | "trusted";
		tasksDone?: number | null;
		tasksRequired?: number | null;
	}
	let { tier, tasksDone, tasksRequired }: Props = $props();

	const accruing = $derived(
		tier === "new" && typeof tasksDone === "number" && typeof tasksRequired === "number"
	);
	// The sign-in note only ever applies to `accruing` (staged-mode, identity-based
	// accrual) — a "uniform" restriction is a blanket policy that applies to every caller alike, so
	// signing in changes nothing about it, and suggesting otherwise would be a real claim this UI
	// can't back. Also only for an ALREADY-anonymous viewer: a signed-in account that is itself
	// still new has nothing further to do here. CUR-761's own PR #515 makes sign-in carry an
	// anonymous session's progress forward rather than resetting it — "carries forward", not
	// "raises": a fresh anonymous session that signs in keeps exactly the tier it had, it does not
	// jump ahead of it. Only a RETURNING signed-in account with its own prior history could end up
	// higher, which isn't a claim this chip is positioned to make per-turn. (CUR-761)
	const canHelpBySigningIn = $derived(accruing && !page.data.user);
</script>

<AnswerNote icon={RiLockLine} title={accruing ? "Editing files is locked for now" : "Editing files is off for this task"}>
	<p>
		Alpha could read, search and reason here, but not change files or run code.
		{#if accruing}
			New agent accounts unlock this after a few tasks ({tasksDone} of {tasksRequired} done).
			{#if canHelpBySigningIn}Sign in and this progress carries over instead of starting from zero.{/if}
		{:else}
			The answer above is still complete for what it could do.
		{/if}
	</p>
</AnswerNote>
