<script lang="ts">
	import { tick } from 'svelte';
	import { feedPreferences } from '$lib/feed-preferences.svelte';
	async function undo() {
		const item = feedPreferences.lastHidden;
		if (!item) return;
		feedPreferences.restore(item);
		await tick();
		document
			.querySelector<HTMLButtonElement>(
				`.feed-panel[data-topic="${CSS.escape(item.topic)}"] [data-feed-item-id="${CSS.escape(item.externalId)}"] .item-actions-button`
			)
			?.focus({ preventScroll: true });
	}
</script>

{#if feedPreferences.lastHidden}
	<div class="feed-undo">
		<span role="status">Το θέμα αποκρύφτηκε.</span>
		<button type="button" class="undo-action" onclick={undo}>Αναίρεση</button>
		<button
			type="button"
			aria-label="Κλείσιμο ειδοποίησης απόκρυψης"
			onclick={() => (feedPreferences.lastHidden = null)}>×</button
		>
	</div>
{/if}

<style>
	.feed-undo {
		position: fixed;
		bottom: max(16px, env(safe-area-inset-bottom));
		left: 50%;
		transform: translateX(-50%);
		z-index: 1800;
		display: flex;
		align-items: center;
		gap: 8px;
		max-width: calc(100% - 24px);
		padding: 4px 8px 4px 16px;
		border: 1px solid var(--color-divider);
		border-radius: 10px;
		background: var(--color-background);
		color: var(--color-text);
		box-shadow: 0 8px 28px #0003;
		font-size: 13px;
	}
	span {
		min-width: 0;
	}
	button {
		min-width: 44px;
		min-height: 44px;
		padding: 0 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--color-action-text);
		cursor: pointer;
	}
	button:hover {
		background: var(--color-secondary-hover);
	}
	button:focus-visible {
		outline: 2px solid var(--color-cerulean);
	}
</style>
