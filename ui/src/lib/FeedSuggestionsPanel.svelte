<script lang="ts">
	import { onMount } from 'svelte';
	import { CommentsApiError } from '$lib/comments-api';
	import { commentsStore } from '$lib/comments-store.svelte';
	import {
		decideFeedSuggestion,
		fetchFeedSuggestions,
		SUGGESTION_STATUSES,
		type FeedSuggestion,
		type SuggestionStatus
	} from '$lib/feed-suggestions-api';
	let { onPending }: { onPending: (count: number) => void } = $props();
	let status = $state('pending');
	let items = $state<FeedSuggestion[]>([]);
	let cursor = $state<string | null>(null);
	let loading = $state(false);
	let busy = $state(false);
	let error = $state('');
	let controller: AbortController | undefined;
	async function load(append = false) {
		controller?.abort();
		const active = new AbortController();
		controller = active;
		loading = true;
		error = '';
		if (!append) {
			items = [];
			cursor = null;
		}
		try {
			const result = await fetchFeedSuggestions(status, append ? cursor : null, active.signal);
			if (active.signal.aborted) return;
			items = append ? [...items, ...result.suggestions] : result.suggestions;
			cursor = result.next_cursor;
			onPending(result.pending);
		} catch (failure) {
			if (!active.signal.aborted) fail(failure);
		} finally {
			if (!active.signal.aborted) loading = false;
		}
	}
	function fail(failure: unknown) {
		if (failure instanceof CommentsApiError && failure.status === 401) {
			commentsStore.moderatorActive = false;
			commentsStore.close();
			items = [];
		}
		error =
			failure instanceof CommentsApiError
				? failure.message
				: 'Δεν ήταν δυνατή η φόρτωση. Δοκίμασε ξανά.';
	}
	async function decide(item: FeedSuggestion, next: SuggestionStatus) {
		if (busy) return;
		busy = true;
		try {
			await decideFeedSuggestion(item.id, next);
			await load();
		} catch (failure) {
			fail(failure);
		} finally {
			busy = false;
		}
	}
	function emailLink(item: FeedSuggestion) {
		const subject = 'Η πηγή που πρότεινες προστέθηκε στο Greeklish.gr';
		const body = `Γεια σου!\n\nΕυχαριστούμε για την πρότασή σου (${item.url}). Η πηγή προστέθηκε στο Greeklish.gr.\n\nhttps://greeklish.gr/\n\nΗ ομάδα του Greeklish.gr`;
		return `mailto:${encodeURIComponent(item.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
	}
	onMount(() => {
		void load();
		return () => controller?.abort();
	});
</script>

<section aria-label="Προτάσεις πηγών" aria-busy={loading || busy}>
	<div class="suggestion-filters">
		<label
			>Κατάσταση<select
				aria-label="Κατάσταση"
				bind:value={status}
				onchange={() => void load()}
				disabled={busy}
			>
				{#each Object.entries(SUGGESTION_STATUSES) as [value, label] (value)}<option {value}
						>{label}</option
					>{/each}
				<option value="all">Όλες</option>
			</select></label
		>
		<button type="button" onclick={() => void load()} disabled={busy || loading}>Ανανέωση</button>
	</div>
	{#if error}<p role="alert">{error}</p>{/if}
	{#if loading && !items.length}<p role="status">Φόρτωση προτάσεων…</p>
	{:else if !items.length && !error}<p>Δεν υπάρχουν προτάσεις σε αυτή την κατηγορία.</p>{/if}
	<ul class="suggestion-list">
		{#each items as item (item.id)}
			<li>
				<h3>{item.name || item.url}</h3>
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- Validated external URL; never fetched automatically. -->
				<a href={item.url} target="_blank" rel="noopener noreferrer">{item.url}</a>
				<p class="suggestion-date">
					{new Date(item.created_at).toLocaleString('el-GR')} · {SUGGESTION_STATUSES[item.status]}
				</p>
				{#if item.explanation}<p class="suggestion-explanation">{item.explanation}</p>{/if}
				{#if item.email}<p class="suggestion-email">Email: {item.email}</p>{/if}
				<div class="suggestion-actions">
					{#each Object.entries(SUGGESTION_STATUSES) as [value, label] (value)}
						{#if value !== item.status}<button
								type="button"
								disabled={busy || loading}
								onclick={() => void decide(item, value as SuggestionStatus)}>{label}</button
							>{/if}
					{/each}
					{#if item.email && item.status === 'added'}
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- Explicit moderator action opens their mail client; no automatic email is sent. -->
						<a class="suggestion-email-action" href={emailLink(item)}>Σύνταξη email</a>
					{/if}
				</div>
			</li>
		{/each}
	</ul>
	{#if cursor}<button type="button" onclick={() => void load(true)} disabled={loading || busy}
			>Περισσότερες προτάσεις</button
		>{/if}
</section>

<style>
	.suggestion-filters,
	.suggestion-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		align-items: end;
	}
	label {
		display: grid;
		gap: 4px;
	}
	button,
	select,
	.suggestion-email-action {
		min-height: 44px;
		box-sizing: border-box;
		padding: 8px 10px;
		border: 1px solid var(--color-divider);
		border-radius: 6px;
		background: var(--color-background);
		color: var(--color-action-text);
		font: inherit;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.55;
	}
	button:focus-visible,
	select:focus-visible,
	a:focus-visible {
		outline: 2px solid var(--color-cerulean);
		outline-offset: 2px;
	}
	.suggestion-list {
		list-style: none;
		padding: 0;
	}
	li {
		border-bottom: 1px solid var(--color-divider);
		padding: 16px 0;
		overflow-wrap: anywhere;
	}
	h3 {
		font-size: 15px;
		margin: 0 0 8px;
	}
	a {
		color: var(--color-action-text);
	}
	.suggestion-date {
		color: var(--color-text-muted);
		font-size: 12px;
	}
	.suggestion-explanation {
		white-space: pre-wrap;
	}
	.suggestion-email-action {
		display: inline-flex;
		align-items: center;
		text-decoration: none;
	}
</style>
