<script lang="ts">
	import { userPrefersMode } from '$lib/theme.svelte';
	import { onMount, setContext } from 'svelte';
	import './layout.css';

	let { children } = $props();

	setContext('wx-theme', 'willow');
	onMount(() => userPrefersMode.initialize());
</script>

<div class="wx-theme wx-willow-theme app-theme">
	{@render children()}
</div>
