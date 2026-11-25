<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { formatAbsoluteDateTime, formatRelativeTime } from '$lib/format';
	import type { GuestComment } from '$lib/comments-api';
	import { commentUrl } from '$lib/comment-links';
	import { commentsStore } from '$lib/comments-store.svelte';
	import CommentNotifications from '$lib/CommentNotifications.svelte';
	import Icon from '$lib/Icon.svelte';

	type Props = {
		comments: GuestComment[];
		loading: boolean;
		error: string | null;
		reduceAnimations: boolean;
		locale: string;
		topic?: string;
		externalId?: string;
		focusId?: string;
		onReply?: (comment: GuestComment) => void;
	};

	let {
		comments,
		loading,
		error,
		reduceAnimations,
		locale,
		topic,
		externalId,
		focusId,
		onReply
	}: Props = $props();

	/** Consecutive comments by one author inside this window share a single name header. */
	const GROUPING_WINDOW_MS = 5 * 60 * 1000;
	/** How close to the bottom counts as "following along". */
	const STICK_THRESHOLD_PX = 80;
	const COMMENT_TRANSITION_DURATION_MS = 200;

	let listElement: HTMLElement | undefined = $state();
	let now = $state(Date.now());
	let highlighted = $state<string | null>(null);
	let revealedId: string | undefined;
	let shareStatus = $state<string | null>(null);
	let manualShareUrl = $state<string | null>(null);
	let shareTimer: ReturnType<typeof setTimeout>;

	type RenderedComment = GuestComment & { grouped: boolean };

	let rendered = $derived.by<RenderedComment[]>(() => {
		let previous: GuestComment | null = null;

		return comments.map((comment) => {
			const sameAuthor = previous?.author_display_name === comment.author_display_name;
			const withinWindow =
				previous != null &&
				Date.parse(comment.created_at) - Date.parse(previous.created_at) < GROUPING_WINDOW_MS;

			previous = comment;

			return {
				...comment,
				grouped: Boolean(sameAuthor && withinWindow && !comment.reply_to_comment_id)
			};
		});
	});

	// The rail is outside `main.page-shell`, so the `.reduce-animations` CSS kill switch cannot
	// reach it. Every transition has to honour the prop in JS instead.
	function flyComment(node: HTMLElement) {
		if (reduceAnimations) return { duration: 0 };

		return fly(node, { y: 8, duration: COMMENT_TRANSITION_DURATION_MS, easing: cubicOut });
	}

	function fadeComment(node: HTMLElement) {
		if (reduceAnimations) return { duration: 0 };

		return fade(node, { duration: COMMENT_TRANSITION_DURATION_MS });
	}

	function isNearBottom() {
		if (!listElement) return true;

		const distance = listElement.scrollHeight - listElement.scrollTop - listElement.clientHeight;

		return distance <= STICK_THRESHOLD_PX;
	}

	export function scrollToBottom(smooth = false) {
		if (!listElement) return;

		listElement.scrollTo({
			top: listElement.scrollHeight,
			behavior: smooth && !reduceAnimations ? 'smooth' : 'auto'
		});
	}

	/** Only follows new arrivals when the reader was already at the bottom. */
	export function followNewComment() {
		if (isNearBottom()) scrollToBottom(true);
	}

	function reveal(id: string, smooth = false) {
		const node = listElement?.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(id)}"]`);
		if (!node || !listElement) return false;
		listElement.scrollTo({
			top:
				listElement.scrollTop +
				node.getBoundingClientRect().top -
				listElement.getBoundingClientRect().top -
				listElement.clientHeight / 2 +
				node.clientHeight / 2,
			behavior: smooth && !reduceAnimations ? 'smooth' : 'auto'
		});
		highlighted = id;
		node.focus({ preventScroll: true });
		return true;
	}

	async function share(comment: GuestComment) {
		if (!topic || !externalId) return;
		const url = commentUrl(topic, externalId, comment.id);
		manualShareUrl = null;
		try {
			if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
				await navigator.share({ title: 'Σχόλιο στο Greeklish.gr', url });
				return;
			}
			if (!navigator.clipboard) throw new Error('Clipboard unavailable');
			await navigator.clipboard.writeText(url);
			shareStatus = 'Ο σύνδεσμος αντιγράφηκε.';
			clearTimeout(shareTimer);
			shareTimer = setTimeout(() => (shareStatus = null), 5000);
		} catch (failure) {
			if (failure instanceof DOMException && failure.name === 'AbortError') return;
			manualShareUrl = url;
			await tick();
			listElement?.querySelector<HTMLInputElement>('.comment-share-url')?.select();
		}
	}

	$effect.pre(() => {
		const entries = comments;
		const target = focusId;
		const nearBottom = isNearBottom();
		void tick().then(() => {
			if (target && target !== revealedId) {
				if (reveal(target)) revealedId = target;
			} else if (entries.length && nearBottom) scrollToBottom();
		});
	});

	onMount(() => {
		scrollToBottom();

		// Relative timestamps go stale on a long-lived panel.
		const timer = setInterval(() => {
			now = Date.now();
		}, 30_000);

		return () => {
			clearInterval(timer);
			clearTimeout(shareTimer);
		};
	});
</script>

<div class="comments-thread" bind:this={listElement} aria-busy={loading}>
	{#if error}
		<p class="comments-thread-error">{error}</p>
	{/if}
	{#if !loading && focusId && !comments.some((comment) => comment.id === focusId)}
		<p class="comments-thread-empty" role="status">
			Το συγκεκριμένο σχόλιο δεν είναι διαθέσιμο. Μπορείς να διαβάσεις την υπόλοιπη συζήτηση.
		</p>
	{/if}
	{#if shareStatus}<p class="share-status" role="status">{shareStatus}</p>{/if}
	{#if manualShareUrl}
		<label class="share-fallback"
			>Αντιγραφή συνδέσμου<input
				class="comment-share-url"
				readonly
				value={manualShareUrl}
				onclick={(event) => event.currentTarget.select()}
			/></label
		>
	{/if}

	{#if loading && !comments.length}
		<p class="comments-thread-empty">Γίνεται φόρτωση…</p>
	{:else if !comments.length && !error}
		<p class="comments-thread-empty">Κανένα σχόλιο ακόμη. Γράψε το πρώτο.</p>
	{/if}

	<ol class="comments-list">
		{#each rendered as comment (comment.id)}
			<li
				data-comment-id={comment.id}
				tabindex="-1"
				class="comment"
				class:comment-highlighted={highlighted === comment.id}
				class:comment-grouped={comment.grouped}
				class:comment-pending={comment.status === 'pending'}
				in:flyComment
				out:fadeComment
			>
				{#if !comment.grouped}
					<p class="comment-head">
						<span class="comment-author">{comment.author_display_name}</span>
						<time
							class="comment-time"
							datetime={comment.created_at}
							title={formatAbsoluteDateTime(comment.created_at, locale)}
						>
							{formatRelativeTime(comment.created_at, now)}
						</time>
						{#if comment.status === 'pending'}
							<span class="comment-tag">Σε αναμονή έγκρισης</span>
						{/if}
					</p>
				{:else if comment.status === 'pending'}
					<p class="comment-head comment-head-grouped">
						<span class="comment-tag">Σε αναμονή έγκρισης</span>
					</p>
				{/if}
				{#if comment.reply_to_comment_id}
					{@const parent = comments.find((entry) => entry.id === comment.reply_to_comment_id)}
					{#if parent}
						<button class="comment-parent" type="button" onclick={() => reveal(parent.id, true)}>
							<span>Απάντηση στον/στην {parent.author_display_name}</span><span
								class="parent-excerpt">{parent.body}</span
							>
						</button>
					{:else}<p class="comment-parent-missing">
							Απάντηση σε σχόλιο που δεν είναι διαθέσιμο.
						</p>{/if}
				{/if}
				<p class="comment-body">{comment.body}</p>
				{#if comment.status === 'approved' && (onReply || (topic && externalId))}
					<div class="comment-actions">
						{#if onReply}<button type="button" onclick={() => onReply?.(comment)}
								><Icon name="arrow-reply-16-regular" size={14} />Απάντηση</button
							>{/if}
						{#if topic && externalId}<button type="button" onclick={() => share(comment)}
								><Icon name="link-16-regular" size={14} />Κοινοποίηση</button
							>{/if}
					</div>
				{/if}
				{#if comment.own}
					<CommentNotifications
						commentId={comment.id}
						prompt={commentsStore.lastSubmitted?.commentId === comment.id}
						onDismiss={() => (commentsStore.lastSubmitted = null)}
					/>
				{/if}
			</li>
		{/each}
	</ol>
</div>

<style>
	.comments-thread {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 12px 16px;
	}

	.comments-list {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.comment {
		padding: 6px 0;
		border-radius: 6px;
		outline-offset: 3px;
	}
	.comment-highlighted {
		background: color-mix(in srgb, var(--color-cerulean) 9%, transparent);
		outline: 1px solid var(--color-cerulean);
	}
	.comment-actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.comment-actions button {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-height: 32px;
		border: 0;
		border-radius: 5px;
		padding: 4px 6px;
		background: transparent;
		color: var(--color-action-text);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	.comment-actions button:hover {
		background: var(--color-secondary-hover);
	}
	.comment-actions button:focus-visible,
	.comment-parent:focus-visible {
		outline: 2px solid var(--color-cerulean);
	}
	.comment-parent {
		display: grid;
		gap: 2px;
		width: 100%;
		margin: 6px 0;
		border: 0;
		border-left: 2px solid var(--color-cerulean);
		padding: 5px 8px;
		text-align: left;
		font: inherit;
		font-size: 12px;
		color: var(--color-action-text);
		background: var(--color-secondary-hover);
		cursor: pointer;
	}
	.parent-excerpt {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		overflow-wrap: anywhere;
		color: var(--color-text-muted);
	}
	.comment-parent-missing {
		font-size: 12px;
		color: var(--color-text-muted);
		margin: 4px 0;
	}
	.share-status,
	.share-fallback {
		display: block;
		color: var(--color-action-text);
		font-size: 12px;
		line-height: 1.6;
	}
	.comment-share-url {
		width: 100%;
		min-height: 44px;
		border: 1px solid var(--color-border);
		background: var(--color-background);
		color: var(--color-text);
		padding: 6px;
	}
	@media (pointer: coarse) {
		.comment-actions button {
			min-height: 44px;
		}
	}

	.comment-grouped {
		padding-top: 0;
	}

	.comment-pending {
		opacity: 0.62;
	}

	.comment-head {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 8px;
		margin: 0 0 2px;
	}

	.comment-head-grouped {
		margin-bottom: 0;
	}

	.comment-author {
		color: var(--color-cerulean);
		font-size: 13px;
		font-weight: 600;
	}

	.comment-time {
		color: var(--color-text-muted);
		font-size: 12px;
		font-variant-numeric: tabular-nums;
	}

	.comment-tag {
		border: 1px solid var(--color-border);
		padding: 0 4px;
		color: var(--color-text-muted);
		font-size: 11px;
		line-height: 15px;
	}

	.comment-body {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: 14px;
		line-height: 20px;
	}

	.comments-thread-empty,
	.comments-thread-error {
		margin: 8px 0;
		color: var(--color-text-muted);
		font-size: 13px;
		line-height: 18px;
	}

	.comments-thread-error {
		color: var(--color-vibrant-coral);
	}
</style>
