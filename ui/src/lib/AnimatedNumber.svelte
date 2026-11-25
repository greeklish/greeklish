<script lang="ts">
	import NumberFlow from '@number-flow/svelte';
	import { onMount } from 'svelte';
	import { animateNumberWidth } from '$lib/actions/animate-number-width';
	import { formatNumber } from '$lib/format';

	type Timing = {
		duration: number;
		easing: string;
	};

	let {
		value,
		locale,
		animated,
		timing,
		dataName,
		fallbackText
	}: {
		value: number;
		locale: string;
		animated: boolean;
		timing: Timing;
		dataName: string;
		fallbackText?: string;
	} = $props();

	let mounted = $state(false);

	onMount(() => {
		mounted = true;
	});
</script>

<span
	class="item-meta-value"
	data-item-meta-value={dataName}
	data-item-meta-fallback={fallbackText}
	use:animateNumberWidth={{ enabled: animated, timing }}
>
	{#if mounted}
		<NumberFlow
			{value}
			locales={locale}
			{animated}
			respectMotionPreference={false}
			transformTiming={timing}
			spinTiming={timing}
			opacityTiming={timing}
		/>
	{:else}
		{formatNumber(value, locale)}
	{/if}
</span>
