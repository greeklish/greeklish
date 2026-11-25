<script lang="ts">
	let { title, onopen }: { title: string; onopen: (event: MouseEvent) => void } = $props();
</script>

<button
	type="button"
	class="item-actions-button"
	aria-haspopup="menu"
	aria-label={`Επιλογές θέματος: ${title}`}
	onclick={onopen}
	title="Επιλογές θέματος">⋯</button
>

<style>
	.item-actions-button {
		width: 28px;
		min-height: 32px;
		padding: 0;
		background: transparent;
		border: 0;
		color: var(--color-text-muted);
		cursor: pointer;
		font-size: 22px;
		border-radius: 6px;
	}
	.item-actions-button:hover {
		background: var(--color-secondary-hover);
		color: var(--color-text);
	}
	button:focus-visible {
		outline: 2px solid var(--color-cerulean);
		outline-offset: -2px;
	}
	@media (pointer: coarse) {
		.item-actions-button {
			width: 44px;
			min-height: 44px;
		}
	}
</style>
