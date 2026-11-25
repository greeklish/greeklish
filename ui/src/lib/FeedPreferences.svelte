<script lang="ts">
	import { tick } from 'svelte';
	import { feedPreferences, type FeedSource } from '$lib/feed-preferences.svelte';
	let { sources }: { sources: FeedSource[] } = $props();
	let dragged = $state<string | null>(null);
	let announcement = $state('');
	const ordered = $derived(feedPreferences.ordered(sources));

	async function move(topic: string, target: string) {
		const focused = document.activeElement;
		feedPreferences.move(topic, target);
		announcement = `Η πηγή ${sources.find((source) => source.topic === topic)?.label} μετακινήθηκε στη θέση ${feedPreferences.value.order.indexOf(topic) + 1}.`;
		await tick();
		if (focused instanceof HTMLElement && focused.isConnected) {
			const target =
				focused instanceof HTMLButtonElement && focused.disabled
					? focused.closest('li')?.querySelector<HTMLButtonElement>('.source-handle')
					: focused;
			target?.focus({ preventScroll: true });
		}
	}
</script>

<section class="feed-preferences" aria-labelledby="feed-preferences-title">
	<h3 id="feed-preferences-title">Προσαρμογή ροής</h3>
	<p class="preference-help">
		Διάλεξε ποιες πηγές βλέπεις και με ποια σειρά. Οι επιλογές αποθηκεύονται σε αυτόν τον browser.
	</p>
	{#if !feedPreferences.savingAvailable}
		<p class="preference-help" role="status">
			Η αποθήκευση δεν είναι διαθέσιμη. Οι αλλαγές ισχύουν για αυτήν την επίσκεψη.
		</p>
	{/if}
	<ol class="source-preferences">
		{#each ordered as source, index (source.topic)}
			<li class:source-hidden={feedPreferences.value.hiddenSources.includes(source.topic)}>
				<button
					class="source-handle"
					type="button"
					draggable="true"
					aria-label={`Μετακίνηση ${source.label}: σύρε ή χρησιμοποίησε τα βέλη`}
					ondragstart={(event) => {
						dragged = source.topic;
						event.dataTransfer?.setData('text/plain', source.topic);
					}}
					ondragend={() => (dragged = null)}
					ondragover={(event) => {
						if (dragged) event.preventDefault();
					}}
					ondrop={(event) => {
						event.preventDefault();
						if (dragged) move(dragged, source.topic);
						dragged = null;
					}}
					onkeydown={(event) => {
						const target =
							event.key === 'ArrowUp'
								? ordered[index - 1]
								: event.key === 'ArrowDown'
									? ordered[index + 1]
									: undefined;
						if (target) {
							event.preventDefault();
							move(source.topic, target.topic);
						}
					}}>⠿</button
				>
				<label
					><input
						type="checkbox"
						checked={!feedPreferences.value.hiddenSources.includes(source.topic)}
						onchange={() => feedPreferences.toggleSource(source.topic)}
					/>{source.label}</label
				>
				<button
					type="button"
					aria-label={`${source.label}: μετακίνηση πάνω`}
					disabled={index === 0}
					onclick={() => move(source.topic, ordered[index - 1].topic)}>↑</button
				>
				<button
					type="button"
					aria-label={`${source.label}: μετακίνηση κάτω`}
					disabled={index === ordered.length - 1}
					onclick={() => move(source.topic, ordered[index + 1].topic)}>↓</button
				>
			</li>
		{/each}
	</ol>
	<p class="visually-hidden" aria-live="polite">{announcement}</p>
	<button
		class="preference-text-button"
		type="button"
		onclick={() => feedPreferences.resetSources()}>Επαναφορά πηγών και σειράς</button
	>
	<details class="hidden-topics">
		<summary>Κρυμμένα θέματα ({feedPreferences.value.hiddenTopics.length})</summary>
		{#if feedPreferences.value.hiddenTopics.length}
			<ul>
				{#each feedPreferences.value.hiddenTopics as item (`${item.topic}/${item.externalId}`)}
					<li>
						<span
							>{item.title}<small
								>{sources.find((source) => source.topic === item.topic)?.label}</small
							></span
						><button
							type="button"
							aria-label={`Επαναφορά: ${item.title}`}
							onclick={() => feedPreferences.restore(item)}>Επαναφορά</button
						>
					</li>
				{/each}
			</ul>
			<button
				class="preference-text-button"
				type="button"
				onclick={() => feedPreferences.restoreAll()}>Επαναφορά όλων των θεμάτων</button
			>
		{:else}<p class="preference-help">Δεν έχεις κρύψει κάποιο θέμα.</p>{/if}
	</details>
</section>

<style>
	.feed-preferences {
		margin-bottom: 24px;
		padding-bottom: 16px;
		border-bottom: 1px solid var(--color-divider);
	}
	h3 {
		margin: 0 0 6px;
		font-size: 16px;
	}
	.preference-help {
		margin: 0 0 12px;
		color: var(--color-text-muted);
		font-size: 13px;
		line-height: 1.5;
	}
	.source-preferences,
	.hidden-topics ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.source-preferences li {
		display: flex;
		align-items: center;
		gap: 4px;
		border-bottom: 1px solid var(--color-divider);
	}
	label {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 44px;
		flex: 1;
		min-width: 0;
		font-size: 14px;
	}
	input {
		width: 18px;
		height: 18px;
		accent-color: var(--color-cerulean);
	}
	button {
		min-width: 44px;
		min-height: 44px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--color-action-text);
		cursor: pointer;
	}
	button:hover {
		background: var(--color-secondary-hover);
	}
	button:disabled {
		opacity: 0.3;
		cursor: default;
	}
	.source-preferences button {
		font-size: 18px;
	}
	button:focus-visible,
	summary:focus-visible {
		outline: 2px solid var(--color-cerulean);
		outline-offset: -2px;
	}
	.source-handle {
		color: var(--color-text-muted);
		cursor: grab;
		font-size: 22px;
	}
	.source-hidden label {
		color: var(--color-text-muted);
	}
	.preference-text-button {
		padding: 0 4px;
		font-size: 13px;
		text-align: left;
	}
	.hidden-topics {
		margin-top: 8px;
	}
	summary {
		cursor: pointer;
		min-height: 44px;
		align-content: center;
		font-size: 14px;
	}
	.hidden-topics li {
		display: flex;
		gap: 12px;
		align-items: center;
		border-top: 1px solid var(--color-divider);
		padding: 6px 0;
	}
	.hidden-topics li span {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
		font-size: 13px;
	}
	small {
		display: block;
		color: var(--color-text-muted);
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
