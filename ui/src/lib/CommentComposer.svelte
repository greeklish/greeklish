<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import Icon from '$lib/Icon.svelte';
	import { commentsStore } from '$lib/comments-store.svelte';

	type Props = {
		threadKey: string;
		/** Called after a successful submit, so the rail can follow the new comment. */
		onSubmitted?: (threadKey: string) => void;
	};

	let { threadKey, onSubmitted }: Props = $props();

	const MAX_BODY_LENGTH = 1000;
	const COUNTER_VISIBLE_FROM = 800;
	const MAX_ROWS = 6;

	let body = $state(untrack(() => commentsStore.drafts.get(threadKey) ?? ''));
	let displayName = $state(commentsStore.displayName);
	let textarea: HTMLTextAreaElement | undefined = $state();
	const replyTarget = $derived(commentsStore.replyTargets.get(threadKey));
	const parentAvailable = $derived(
		!replyTarget ||
			!!commentsStore.threads
				.get(threadKey)
				?.comments.some((comment) => comment.id === replyTarget.id && comment.status === 'approved')
	);

	/** Enter-to-send only where there is a real keyboard; on touch Enter must insert a newline. */
	let pointerIsFine = $state(false);

	let clock = $state(Date.now());
	let retrySeconds = $derived(
		Math.max(
			0,
			Math.ceil((commentsStore.retryDeadline(threadKey) - Math.max(clock, Date.now())) / 1000)
		)
	);
	let retryLabel = $derived(
		retrySeconds >= 3600
			? `${Math.floor(retrySeconds / 3600)}:${String(Math.floor(retrySeconds / 60) % 60).padStart(2, '0')}:${String(retrySeconds % 60).padStart(2, '0')}`
			: `${Math.floor(retrySeconds / 60)}:${String(retrySeconds % 60).padStart(2, '0')}`
	);
	let trimmedLength = $derived(body.trim().length);
	let canSubmit = $derived(
		trimmedLength >= 2 && !commentsStore.submitting && retrySeconds === 0 && parentAvailable
	);
	let showCounter = $derived(body.length >= COUNTER_VISIBLE_FROM);

	function autoGrow() {
		if (!textarea) return;

		textarea.style.height = 'auto';
		const lineHeight = 20;
		const maxHeight = lineHeight * MAX_ROWS;
		textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
	}

	export function focus() {
		textarea?.focus();
	}

	/**
	 * Starts the proof of work as soon as the composer is focused.
	 *
	 * By the time the visitor finishes typing the challenge is already solved, which is what makes
	 * the check feel like it never happened.
	 */
	function prepare() {
		void commentsStore.prepareCaptcha();
	}

	async function send() {
		if (!canSubmit) return;

		const draft = body;
		const submitted = await commentsStore.submit(draft, displayName);

		if (submitted) {
			body = '';
			commentsStore.drafts.delete(threadKey);
			autoGrow();
			onSubmitted?.(threadKey);
			return;
		}

		// Restore the draft so a rate limit or a network blip never loses what was typed.
		body = draft;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.isComposing) return;
		if (!pointerIsFine || event.shiftKey) return;

		event.preventDefault();
		void send();
	}

	function changeDisplayName(event: Event) {
		const value = (event.currentTarget as HTMLInputElement).value;
		displayName = value;
		commentsStore.displayName = value;
	}

	onMount(() => {
		autoGrow();
		const timer = setInterval(() => {
			clock = Date.now();
		}, 250);
		return () => clearInterval(timer);
	});

	$effect(() => {
		pointerIsFine = window.matchMedia('(pointer: fine)').matches;
	});
</script>

<form
	class="comment-composer"
	onsubmit={(event) => {
		event.preventDefault();
		void send();
	}}
>
	{#if replyTarget}
		<div class="composer-reply-target">
			<div>
				<span>Απάντηση στον/στην {replyTarget.author_display_name}</span>
				<p>{replyTarget.body}</p>
			</div>
			<button
				type="button"
				aria-label="Ακύρωση απάντησης"
				onclick={() => commentsStore.replyTargets.delete(threadKey)}
				><Icon name="dismiss-16-regular" size={16} /></button
			>
		</div>
		{#if !parentAvailable}<p class="composer-hint" role="status">
				Το αρχικό σχόλιο δεν είναι πλέον διαθέσιμο. Ακύρωσε την απάντηση για να γράψεις νέο σχόλιο
				στο άρθρο.
			</p>{/if}
	{/if}
	<input
		class="composer-name"
		type="text"
		value={displayName}
		placeholder="Επισκέπτης"
		maxlength="24"
		autocomplete="nickname"
		aria-label="Το όνομά σου"
		oninput={changeDisplayName}
		onfocus={prepare}
	/>

	<div class="composer-row">
		<textarea
			bind:this={textarea}
			bind:value={body}
			class="composer-body"
			rows="1"
			maxlength={MAX_BODY_LENGTH}
			placeholder={replyTarget ? 'Γράψε την απάντησή σου…' : 'Γράψε ένα σχόλιο…'}
			aria-label="Το σχόλιό σου"
			oninput={() => {
				commentsStore.drafts.set(threadKey, body);
				autoGrow();
			}}
			onfocus={prepare}
			onkeydown={handleKeydown}
		></textarea>

		<button
			class="composer-send"
			type="submit"
			disabled={!canSubmit}
			title={retrySeconds ? `Αποστολή σε ${retryLabel}` : 'Αποστολή'}
			aria-label="Αποστολή σχολίου"
		>
			<Icon name="send-16-regular" size={16} />
		</button>
	</div>
	{#if !commentsStore.authorToken}<p class="composer-hint">
			Χωρίς εγγραφή. Το όνομα είναι προαιρετικό.
		</p>{/if}

	{#if retrySeconds > 0}
		<div class="composer-cooldown">
			{#if commentsStore.retryMessage}<span role="status">{commentsStore.retryMessage}</span>{/if}
			<span>Επόμενο σχόλιο σε <strong role="timer" aria-live="off">{retryLabel}</strong></span>
		</div>
	{/if}

	<div class="composer-status" aria-live="polite">
		{#if commentsStore.submitError}
			<span class="composer-error">{commentsStore.submitError}</span>
		{:else if commentsStore.lastHeld}
			<span>Το σχόλιό σου στάλθηκε για έλεγχο.</span>
		{:else if commentsStore.captchaState === 'solving'}
			<span>Έλεγχος ασφαλείας…</span>
		{:else if commentsStore.captchaState === 'error'}
			<span class="composer-error">Ο έλεγχος ασφαλείας απέτυχε. Δοκίμασε ξανά.</span>
		{:else if pointerIsFine && trimmedLength > 0}
			<span>Enter για αποστολή, Shift+Enter για νέα γραμμή.</span>
		{/if}

		{#if showCounter}
			<span class="composer-counter">{body.length}/{MAX_BODY_LENGTH}</span>
		{/if}
	</div>
</form>

<style>
	.comment-composer {
		flex: 0 0 auto;
		display: grid;
		gap: 8px;
		border-top: 1px solid var(--color-border);
		background: var(--color-surface);
		padding: 12px 16px max(12px, env(safe-area-inset-bottom));
	}
	.composer-reply-target {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		border-left: 2px solid var(--color-cerulean);
		padding-left: 8px;
		font-size: 12px;
		color: var(--color-action-text);
	}
	.composer-reply-target div {
		min-width: 0;
		flex: 1;
	}
	.composer-reply-target p {
		margin: 2px 0 0;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		overflow-wrap: anywhere;
		color: var(--color-text-muted);
	}
	.composer-reply-target button {
		border: 0;
		background: transparent;
		color: var(--color-text-muted);
		min-width: 44px;
		min-height: 44px;
		cursor: pointer;
	}
	.composer-hint {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 12px;
		line-height: 1.5;
	}

	.composer-cooldown {
		display: grid;
		gap: 4px;
		font-size: 12px;
		color: var(--color-text-muted);
		line-height: 1.5;
	}
	.composer-cooldown strong {
		font-variant-numeric: tabular-nums;
		color: var(--color-text);
	}
	.composer-name {
		box-sizing: border-box;
		border: 1px solid var(--color-border);
		background: transparent;
		padding: 4px 8px;
		width: 100%;
		color: inherit;
		font: inherit;
		font-size: 13px;
	}

	.composer-row {
		display: flex;
		align-items: flex-end;
		gap: 8px;
	}

	.composer-body {
		flex: 1 1 auto;
		box-sizing: border-box;
		border: 1px solid var(--color-border);
		background: transparent;
		padding: 6px 8px;
		min-width: 0;
		resize: none;
		color: inherit;
		font: inherit;
		line-height: 20px;
	}

	.composer-send {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--color-border);
		background: transparent;
		padding: 0;
		width: 36px;
		height: 36px;
		color: var(--color-cerulean);
		cursor: pointer;
	}

	.composer-send:hover:not(:disabled) {
		color: var(--color-tropical-teal);
	}

	.composer-send:disabled {
		border-color: var(--color-disabled);
		color: var(--color-disabled);
		cursor: default;
	}

	.composer-status {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		min-height: 16px;
		color: var(--color-text-muted);
		font-size: 12px;
		line-height: 16px;
	}

	.composer-error {
		color: var(--color-vibrant-coral);
	}

	.composer-counter {
		flex: 0 0 auto;
		font-variant-numeric: tabular-nums;
	}
</style>
