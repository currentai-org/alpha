<script lang="ts">
	import RiRobot2Line from '~icons/ri/robot-2-line';
	import AnswerNote from './AnswerNote.svelte';
	// Agent was on Auto and the agent service's route check failed or timed out, so nobody
	// decided this turn was an ordinary one; the selected model answered it anyway. The answer above is
	// real. A "direct" verdict shows nothing, since the agent was asked and declined. (CUR-2830)
</script>

<AnswerNote icon={RiRobot2Line} title="The agent wasn’t reachable">
	<p>
		Agent is on Auto, but Alpha couldn’t check whether this needed the agent, so the answer above
		came straight from the model. To run it as a job, set Agent to On and send it again.
	</p>
</AnswerNote>
