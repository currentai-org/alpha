<script lang="ts">
	import { Icon, Inline } from '@aipotluck/alpha-ds';
	import RiAddLine from '~icons/ri/add-line';
	import RiSettings3Line from '~icons/ri/settings-3-line';
	import RiSendPlaneFill from '~icons/ri/send-plane-fill';
	import RiDeleteBinFill from '~icons/ri/delete-bin-fill';
</script>

<Inline gap="4">
	<Icon icon={RiAddLine} tone="default" size="lg" />
	<Icon icon={RiSettings3Line} tone="muted" size="lg" />
	<Icon icon={RiSendPlaneFill} tone="accent" size="lg" label="Send" />
	<Icon icon={RiDeleteBinFill} tone="destructive" size="lg" label="Delete" />
</Inline>
