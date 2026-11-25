<script lang="ts">
	import { onMount } from 'svelte';
	import { CommentsApiError, fetchDiscussions, type Discussion } from '$lib/comments-api';
	import { formatAbsoluteDateTime, formatRelativeTime } from '$lib/format';
	import Icon from '$lib/Icon.svelte';

	let { locale, onSelect }: { locale: string; onSelect: (discussion: Discussion) => void } =
		$props();
	let discussions = $state<Discussion[]>([]);
	let cursor = $state<string | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let now = $state(Date.now());
	let controller: AbortController;

	async function load() {
		loading = true;
		error = null;
		try {
			const response = await fetchDiscussions(cursor, controller.signal);
			if (controller.signal.aborted) return;
			// A discussion can move between pages when a new comment arrives.
			discussions = [
				...discussions.filter(
					(entry) =>
						!response.discussions.some(
							(next) => next.topic === entry.topic && next.external_id === entry.external_id
						)
				),
				...response.discussions
			];
			cursor = response.next_cursor;
		} catch (failure) {
			if (controller.signal.aborted) return;
			error =
				failure instanceof CommentsApiError
					? failure.message
					: 'Δεν ήταν δυνατή η φόρτωση των συζητήσεων.';
		} finally {
			if (!controller.signal.aborted) loading = false;
		}
	}

	onMount(() => {
		controller = new AbortController();
		void load();
		const timer = setInterval(() => {
			now = Date.now();
		}, 30_000);
		return () => {
			controller.abort();
			clearInterval(timer);
		};
	});
</script>

<div class="discussions-list" aria-busy={loading}>
	{#if loading && !discussions.length}
		<p class="discussions-message" role="status">Γίνεται φόρτωση…</p>
	{:else if !discussions.length && !error}
		<p class="discussions-message">
			Δεν υπάρχουν συζητήσεις ακόμη. Άνοιξε τα σχόλια ενός άρθρου για να ξεκινήσεις μία.
		</p>
	{/if}
	<ul>
		{#each discussions as discussion (JSON.stringify([discussion.topic, discussion.external_id]))}
			<li>
				<button class="discussion-entry" type="button" onclick={() => onSelect(discussion)}>
					<span class="discussion-source">{discussion.topic_display_name}</span>
					<span class="discussion-title">{discussion.item_title}</span>
					<span class="discussion-meta">
						<span class="discussion-count"
							><Icon name="comment-16-regular" size={14} />{discussion.guest_comment_count}
							{discussion.guest_comment_count === 1 ? 'σχόλιο' : 'σχόλια'}</span
						>
						<time
							datetime={discussion.last_comment_at}
							title={formatAbsoluteDateTime(discussion.last_comment_at, locale)}
							>{formatRelativeTime(discussion.last_comment_at, now)}</time
						>
					</span>
				</button>
			</li>
		{/each}
	</ul>
	{#if error}
		<p class="discussions-error" role="alert">{error}</p>
	{/if}
	{#if error || cursor}
		<button class="discussions-more" type="button" disabled={loading} onclick={load}>
			{loading ? 'Γίνεται φόρτωση…' : error ? 'Δοκίμασε ξανά' : 'Περισσότερες συζητήσεις'}
		</button>
	{/if}
</div>

<style>
	.discussions-list {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 0 16px 16px;
	}
	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		border-bottom: 1px solid var(--color-border);
	}
	.discussion-entry {
		display: grid;
		gap: 6px;
		width: 100%;
		border: 0;
		background: transparent;
		padding: 14px 4px;
		color: var(--color-text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.discussion-entry:hover {
		background: var(--color-secondary-hover);
	}
	.discussion-entry:focus-visible,
	.discussions-more:focus-visible {
		outline: 2px solid var(--color-cerulean);
		outline-offset: -2px;
	}
	.discussion-source {
		color: var(--color-cerulean);
		font-size: 12px;
	}
	.discussion-title {
		overflow-wrap: anywhere;
		font-size: 14px;
		line-height: 1.5;
		font-weight: 600;
	}
	.discussion-meta {
		display: flex;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 4px 12px;
		color: var(--color-text-muted);
		font-size: 12px;
	}
	.discussion-count {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.discussions-message {
		color: var(--color-text-muted);
		font-size: 13px;
		line-height: 1.6;
	}
	.discussions-error {
		color: var(--color-vibrant-coral);
		font-size: 13px;
	}
	.discussions-more {
		margin-top: 12px;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: transparent;
		padding: 8px 12px;
		color: var(--color-text);
		font: inherit;
		cursor: pointer;
	}
	.discussions-more:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>
