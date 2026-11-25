<script lang="ts">
	import { page } from '$app/state';

	import Icon from '$lib/Icon.svelte';
	let {
		sources,
		onCustomize
	}: { sources: { topic: string; label: string }[]; onCustomize?: () => void } = $props();
</script>

<nav class="source-navigation" aria-label="Μετάβαση σε πηγή">
	<span class="source-label" aria-hidden="true">Πηγές</span>
	<div class="source-links">
		{#each sources as source (source.topic)}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- Same-page fragment, including without JavaScript. -->
			<a
				href={`#feed-${source.topic}`}
				aria-current={page.url.hash === `#feed-${source.topic}` ? 'location' : undefined}
			>
				{source.label}
			</a>
		{/each}
	</div>
	{#if onCustomize}
		<button
			class="customize-sources"
			type="button"
			aria-label="Προσαρμογή ροής"
			title="Προσαρμογή ροής"
			onclick={onCustomize}><Icon name="settings-16-regular" size={18} /></button
		>
	{/if}
</nav>

<style>
	.source-navigation {
		position: sticky;
		top: 0;
		z-index: 1200;
		display: flex;
		align-items: center;
		gap: 10px;
		height: 64px;
		margin-bottom: 16px;
		border-bottom: 1px solid var(--color-divider);
		background: var(--color-background);
	}

	.source-label {
		flex: 0 0 auto;
		font-size: 12px;
		font-weight: 600;
		color: var(--color-text-muted);
	}

	.source-links {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		flex: 1;
		overflow-x: auto;
		scrollbar-width: thin;
		scrollbar-color: var(--color-divider) transparent;
	}
	.customize-sources {
		display: grid;
		place-items: center;
		flex: 0 0 44px;
		min-height: 44px;
		border: 1px solid var(--color-divider);
		border-radius: 8px;
		background: var(--color-background);
		color: var(--color-action-text);
		cursor: pointer;
	}
	.customize-sources:hover {
		background: var(--color-secondary-hover);
	}
	.customize-sources:focus-visible {
		outline: 2px solid var(--color-cerulean);
		outline-offset: -3px;
	}

	a {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		min-height: 44px;
		border: 1px solid var(--color-divider);
		border-radius: 8px;
		padding: 0 12px;
		font-size: 13px;
		color: var(--color-text);
		text-decoration: none;
		touch-action: manipulation;
	}

	a[aria-current='location'] {
		border-color: var(--color-cerulean);
		background: var(--color-secondary-hover);
		color: var(--color-action-text);
	}

	@media (hover: hover) {
		a:hover {
			border-color: var(--color-cerulean);
			background: var(--color-secondary-hover);
			color: var(--color-action-text);
		}
	}

	a:focus-visible {
		outline: 2px solid var(--color-cerulean);
		outline-offset: -3px;
	}

	@container app-main (min-width: 1180px) {
		.source-navigation {
			display: none;
		}
	}
</style>
