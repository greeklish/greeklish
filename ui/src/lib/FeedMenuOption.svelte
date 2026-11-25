<script lang="ts">
	import Icon from '$lib/Icon.svelte';
	import type { IconName } from '$lib/icons';

	let { option = {} } = $props<{ option?: { text?: string; icon?: string } }>();
</script>

{#if option.icon}
	<Icon name={option.icon as IconName} size={16} class="feed-menu-option-icon" />
{/if}
<span class="wx-value">{option.text}</span>
