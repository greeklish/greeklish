<script lang="ts">
	import { onMount } from 'svelte';
	import { commentsStore, type OpenThread } from '$lib/comments-store.svelte';
	import { replyNotifications as notifications } from '$lib/reply-notifications.svelte';
	import { formatRelativeTime, formatAbsoluteDateTime } from '$lib/format';
	import type { ReplyNotification } from '$lib/comments-api';
	let { locale, onSelect }: { locale: string; onSelect: (thread: OpenThread) => void } = $props();
	let now = $state(Date.now());
	function open(reply: ReplyNotification) {
		void notifications.markRead(reply.id);
		onSelect({
			topic: reply.topic,
			externalId: reply.external_id,
			title: reply.item_title,
			url: reply.item_url,
			topicDisplayName: '',
			commentId: reply.reply_id
		});
	}
	onMount(() => {
		void notifications.load();
		const timer = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(timer);
	});
</script>

<div class="reply-inbox" aria-busy={notifications.loading}>
	{#if !commentsStore.authorToken}
		<p class="inbox-message">
			Γράψε ένα σχόλιο χωρίς εγγραφή. Οι απαντήσεις που θα λάβεις θα εμφανίζονται εδώ, σε αυτόν τον
			περιηγητή.
		</p>
	{:else}
		<div class="inbox-tools">
			<button type="button" disabled={notifications.loading} onclick={() => notifications.load()}>
				{notifications.newReplies ? 'Νέες απαντήσεις — Ανανέωση' : 'Ανανέωση'}
			</button>
			{#if notifications.unread > 0}<button type="button" onclick={() => notifications.markRead()}
					>Όλες διαβασμένες</button
				>{/if}
		</div>
		{#if !notifications.replies.length && !notifications.error}
			<p class="inbox-message" role="status">
				{notifications.loading
					? 'Γίνεται φόρτωση…'
					: 'Δεν έχεις λάβει απαντήσεις ακόμη. Θα τις βλέπεις εδώ, ακόμη και χωρίς ειδοποιήσεις.'}
			</p>
		{/if}
		<ul>
			{#each notifications.replies as reply (reply.id)}
				<li>
					<button
						class="reply-entry"
						class:unread={reply.unread}
						type="button"
						onclick={() => open(reply)}
					>
						<span class="reply-heading"
							><strong>{reply.author_display_name}</strong><span>απάντησε στο σχόλιό σου</span
							>{#if reply.unread}<span class="unread-label">Νέα</span>{/if}</span
						>
						<span class="reply-excerpt">{reply.body}</span>
						<span class="reply-article">{reply.item_title}</span>
						<time
							datetime={reply.created_at}
							title={formatAbsoluteDateTime(reply.created_at, locale)}
							>{formatRelativeTime(reply.created_at, now)}</time
						>
					</button>
				</li>
			{/each}
		</ul>
		{#if notifications.error}<p class="inbox-message" role="alert">{notifications.error}</p>{/if}
		{#if notifications.cursor}<button
				class="more-replies"
				type="button"
				disabled={notifications.loading}
				onclick={() => notifications.load(true)}>Παλαιότερες απαντήσεις</button
			>{/if}
		<p class="inbox-retention">
			Απαντήσεις των τελευταίων 90 ημερών, για τα σχόλια που έγραψες από αυτόν τον περιηγητή.
		</p>
	{/if}
</div>

<style>
	.reply-inbox {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 0 16px 16px;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	li {
		border-bottom: 1px solid var(--color-divider);
	}
	button {
		cursor: pointer;
		font: inherit;
		color: var(--color-action-text);
		background: transparent;
		border: 0;
		border-radius: 6px;
		min-height: 44px;
	}
	button:focus-visible {
		outline: 2px solid var(--color-cerulean);
		outline-offset: -2px;
	}
	button:disabled {
		opacity: 0.6;
		cursor: default;
	}
	button:hover {
		background: var(--color-secondary-hover);
	}
	.inbox-tools {
		display: flex;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 4px;
		margin: 4px 0;
		font-size: 12px;
	}
	.reply-entry {
		display: grid;
		gap: 6px;
		width: 100%;
		padding: 12px 8px;
		text-align: left;
		color: var(--color-text);
	}
	.unread {
		background: color-mix(in srgb, var(--color-cerulean) 7%, transparent);
	}
	.reply-heading {
		display: flex;
		align-items: center;
		gap: 4px 6px;
		flex-wrap: wrap;
		font-size: 12px;
	}
	.reply-heading strong {
		color: var(--color-action-text);
	}
	.unread-label {
		color: var(--color-action-text);
		font-weight: 600;
		margin-left: auto;
	}
	.reply-excerpt {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		overflow: hidden;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
		font-size: 14px;
		line-height: 1.5;
	}
	.reply-article {
		overflow-wrap: anywhere;
		color: var(--color-text-muted);
		font-size: 12px;
		line-height: 1.5;
	}
	time {
		font-size: 11px;
		color: var(--color-text-muted);
	}
	.inbox-message,
	.inbox-retention {
		color: var(--color-text-muted);
		font-size: 13px;
		line-height: 1.6;
	}
	.inbox-retention {
		font-size: 12px;
		margin-top: 16px;
	}
	.more-replies {
		margin-top: 10px;
		font-size: 13px;
	}
</style>
