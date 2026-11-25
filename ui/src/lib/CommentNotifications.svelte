<script lang="ts">
	import { replyNotifications as notifications } from '$lib/reply-notifications.svelte';
	import Icon from '$lib/Icon.svelte';
	let {
		commentId,
		prompt = false,
		onDismiss
	}: { commentId: string; prompt?: boolean; onDismiss?: () => void } = $props();
	const watched = $derived(notifications.watched.has(commentId));
	const busy = $derived(notifications.busy === commentId);
</script>

{#if notifications.pushEnabled && (prompt || notifications.supported)}
	<div class="comment-notifications" class:notification-prompt={prompt}>
		{#if prompt && !watched}
			<p>Να σε ειδοποιούμε όταν απαντήσει κάποιος σε αυτό το σχόλιο;</p>
		{:else if prompt && watched}
			<p role="status">Θα ειδοποιείσαι για απαντήσεις σε αυτό το σχόλιο.</p>
		{/if}
		{#if notifications.needsHomeScreen}
			<p class="notification-help">
				Στο iPhone ή iPad: Κοινή χρήση → Προσθήκη στην Αρχική οθόνη. Άνοιξε την εφαρμογή από εκεί
				και γράψε το σχόλιό σου για να ενεργοποιήσεις ειδοποιήσεις. Η ταυτότητα σχολιασμού μπορεί να
				διαφέρει από αυτήν του browser.
			</p>
		{:else if !notifications.supported}
			<p class="notification-help">
				Ο περιηγητής δεν υποστηρίζει ειδοποιήσεις. Θα βρίσκεις τις απαντήσεις στις «Απαντήσεις μου».
			</p>
		{:else}
			<div class="notification-actions">
				<button
					type="button"
					class:watch-active={watched}
					aria-pressed={watched}
					disabled={!!notifications.busy || (!watched && !notifications.pushReady)}
					onclick={() => notifications.toggleWatch(commentId)}
				>
					<Icon name="alert-16-regular" size={14} />
					{busy
						? 'Περίμενε…'
						: watched
							? 'Διακοπή ειδοποιήσεων'
							: prompt
								? 'Ενεργοποίηση'
								: 'Ειδοποίηση για απαντήσεις'}
				</button>
			</div>
			{#if notifications.permission === 'denied' && !notifications.pushError}
				<p class="notification-help">
					Οι ειδοποιήσεις είναι αποκλεισμένες στις ρυθμίσεις του περιηγητή. Οι απαντήσεις σου
					εμφανίζονται και εδώ.
				</p>
			{/if}
		{/if}
		{#if notifications.pushError && (notifications.lastAction === commentId || prompt)}
			<p class="notification-error" role="status">{notifications.pushError}</p>
		{/if}
		{#if prompt}
			<button class="dismiss-prompt" type="button" onclick={onDismiss}
				>{watched ? 'Κλείσιμο' : 'Όχι τώρα'}</button
			>
		{/if}
	</div>
{/if}

<style>
	.comment-notifications {
		font-size: 12px;
		line-height: 1.5;
	}
	.notification-prompt {
		position: relative;
		border: 1px solid var(--color-divider);
		border-radius: 8px;
		padding: 10px;
		background: var(--color-secondary-hover);
	}
	p {
		margin: 0 0 6px;
	}
	.notification-help {
		color: var(--color-text-muted);
	}
	.notification-error {
		color: var(--color-text);
		margin-top: 6px;
	}
	button {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 36px;
		border: 0;
		background: transparent;
		padding: 4px 6px;
		color: var(--color-action-text);
		font: inherit;
		cursor: pointer;
		border-radius: 5px;
	}
	button:hover,
	.watch-active {
		background: var(--color-secondary-hover);
	}
	button:focus-visible {
		outline: 2px solid var(--color-cerulean);
		outline-offset: 1px;
	}
	button:disabled {
		cursor: default;
		opacity: 0.6;
	}
	.dismiss-prompt {
		color: var(--color-text-muted);
	}
	@media (pointer: coarse) {
		button {
			min-height: 44px;
		}
	}
</style>
