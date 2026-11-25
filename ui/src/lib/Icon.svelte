<script lang="ts">
	import { icons, type IconName } from '$lib/icons';

	let {
		name,
		size = 24,
		label = undefined,
		class: className = ''
	}: {
		name: IconName;
		size?: number;
		label?: string;
		class?: string;
	} = $props();

	const Component = $derived(icons[name]);
</script>

<Component
	class={className}
	width={size}
	height={size}
	aria-hidden={label ? undefined : 'true'}
	aria-label={label}
/>
