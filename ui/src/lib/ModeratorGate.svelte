<script lang="ts">
	import { flushSync, onMount } from 'svelte';
	import AppModalArea from '$lib/AppModalArea.svelte';
	import { commentsStore } from '$lib/comments-store.svelte';
	import { CommentsApiError, createModeratorSession } from '$lib/comments-api';

	type Props = {
		reduceMotion: boolean;
	};

	let { reduceMotion }: Props = $props();

	/** Keyboard sequence. Compared case-insensitively against `event.key`. */
	const KONAMI_KEYS = [
		'arrowup',
		'arrowup',
		'arrowdown',
		'arrowdown',
		'arrowleft',
		'arrowright',
		'arrowleft',
		'arrowright',
		'b',
		'a'
	] as const;

	/** Touch sequence: the same shape, minus the two letters, which the keyboard supplies. */
	const SWIPE_SEQUENCE = ['up', 'up', 'down', 'down', 'left', 'right', 'left', 'right'] as const;

	const MIN_SWIPE_DISTANCE_PX = 48;
	const DOMINANT_AXIS_RATIO = 2;
	const MAX_SWIPE_DURATION_MS = 700;
	const MAX_SWIPE_GAP_MS = 2500;
	const SEQUENCE_BUDGET_MS = 20_000;

	type Stage = 'idle' | 'letters' | 'password';
	type Direction = 'up' | 'down' | 'left' | 'right';

	let stage = $state<Stage>('idle');
	let letters = $state('');
	let password = $state('');
	let error = $state<string | null>(null);
	let submitting = $state(false);

	let letterInput: HTMLInputElement | undefined = $state();
	let passwordInput: HTMLInputElement | undefined = $state();

	let keyIndex = 0;
	let swipeIndex = 0;
	let sequenceStartedAt = 0;
	let lastSwipeAt = 0;
	let touchStart: { id: number; x: number; y: number; time: number } | null = null;

	function reset() {
		stage = 'idle';
		letters = '';
		password = '';
		error = null;
		keyIndex = 0;
		swipeIndex = 0;
		touchStart = null;
	}

	/**
	 * Keyboard detector.
	 *
	 * Events originating in a text field are ignored: the comment composer contains both `b` and
	 * `a`, and without this guard ordinary typing would advance the sequence.
	 */
	function handleKeydown(event: KeyboardEvent) {
		if (stage === 'letters' && event.key === 'Escape') {
			event.preventDefault();
			reset();
			return;
		}
		if (stage !== 'idle') return;

		const target = event.target;
		if (
			target instanceof HTMLElement &&
			(target.tagName === 'INPUT' ||
				target.tagName === 'TEXTAREA' ||
				target.tagName === 'SELECT' ||
				target.isContentEditable)
		) {
			return;
		}

		const key = event.key.toLowerCase();

		if (key === KONAMI_KEYS[keyIndex]) {
			keyIndex += 1;

			if (keyIndex === KONAMI_KEYS.length) {
				// Focus changes during keydown; consume the final letter before its default
				// text insertion can follow focus into the password field.
				event.preventDefault();
				keyIndex = 0;
				openPassword();
			}

			return;
		}

		// Re-test the offending key against the first step, so a restart is not swallowed.
		keyIndex = key === KONAMI_KEYS[0] ? 1 : 0;
	}

	function handleTouchStart(event: TouchEvent) {
		if (stage !== 'idle') return;
		if (event.touches.length !== 1) {
			handleTouchCancel();
			return;
		}

		const touch = event.touches[0];
		touchStart = {
			id: touch.identifier,
			x: touch.clientX,
			y: touch.clientY,
			time: event.timeStamp
		};
	}

	function handleTouchCancel() {
		touchStart = null;
		swipeIndex = 0;
	}

	/**
	 * Swipe detector.
	 *
	 * Never calls `preventDefault()`: the vertical swipes are ordinary page scrolling and must keep
	 * scrolling the page. Touch events keep delivering the release after native scrolling cancels
	 * the pointer stream, so observing pointerup would miss these swipes.
	 */
	function handleTouchEnd(event: TouchEvent) {
		if (stage !== 'idle' || !touchStart) return;

		const start = touchStart;
		const touch = Array.from(event.changedTouches).find((touch) => touch.identifier === start.id);
		if (!touch) return;
		touchStart = null;

		const deltaX = touch.clientX - start.x;
		const deltaY = touch.clientY - start.y;
		const duration = event.timeStamp - start.time;

		if (duration > MAX_SWIPE_DURATION_MS) {
			swipeIndex = 0;
			return;
		}

		const direction = classifySwipe(deltaX, deltaY);
		if (!direction) return;

		const now = event.timeStamp;

		if (swipeIndex > 0 && now - lastSwipeAt > MAX_SWIPE_GAP_MS) swipeIndex = 0;
		if (swipeIndex === 0) sequenceStartedAt = now;
		if (now - sequenceStartedAt > SEQUENCE_BUDGET_MS) {
			swipeIndex = 0;
			sequenceStartedAt = now;
		}

		lastSwipeAt = now;

		if (direction !== SWIPE_SEQUENCE[swipeIndex]) {
			swipeIndex = direction === SWIPE_SEQUENCE[0] ? 1 : 0;
			sequenceStartedAt = now;
			return;
		}

		swipeIndex += 1;

		if (swipeIndex === SWIPE_SEQUENCE.length) {
			swipeIndex = 0;
			// Mount the input before focusing, while still inside the touchend gesture task.
			flushSync(() => {
				stage = 'letters';
				letters = '';
			});
			letterInput?.focus({ preventScroll: true });
		}
	}

	function classifySwipe(deltaX: number, deltaY: number): Direction | null {
		const absX = Math.abs(deltaX);
		const absY = Math.abs(deltaY);

		if (absX >= MIN_SWIPE_DISTANCE_PX && absX >= absY * DOMINANT_AXIS_RATIO) {
			return deltaX > 0 ? 'right' : 'left';
		}

		if (absY >= MIN_SWIPE_DISTANCE_PX && absY >= absX * DOMINANT_AXIS_RATIO) {
			return deltaY > 0 ? 'down' : 'up';
		}

		return null;
	}

	function handleLetterInput(event: Event) {
		const value = (event.currentTarget as HTMLInputElement).value.toLowerCase();
		letters = value;

		if (value === 'ba') {
			openPassword();
			return;
		}

		// A wrong letter invalidates the whole sequence and dismisses the input immediately.
		if (value !== '' && value !== 'b') {
			flushSync(reset);
		}
	}

	function openPassword() {
		flushSync(() => {
			stage = 'password';
			password = '';
			error = null;
		});
		// Flush the modal's mount/focus effects before focusing the new input in the same task.
		passwordInput?.focus({ preventScroll: true });
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();

		if (submitting || !password) return;

		submitting = true;
		error = null;

		try {
			await createModeratorSession(password);
			commentsStore.moderatorActive = true;
			// A verified session has different posting limits; let the server apply those.
			commentsStore.retryUntil = 0;
			commentsStore.itemRetryUntil.clear();
			commentsStore.retryMessage = '';
			commentsStore.submitError = null;
			commentsStore.openModeration();
			reset();
		} catch (failure) {
			// Deliberately generic, with no attempt counter: the server-side lockout does the real
			// work and must not be disclosed.
			error =
				failure instanceof CommentsApiError && failure.code === 'rate_limited'
					? failure.message
					: 'Λάθος κωδικός.';
			password = '';
		} finally {
			submitting = false;
		}
	}

	onMount(() => {
		window.addEventListener('keydown', handleKeydown);
		window.addEventListener('touchstart', handleTouchStart, { passive: true });
		window.addEventListener('touchend', handleTouchEnd, { passive: true });
		window.addEventListener('touchcancel', handleTouchCancel, { passive: true });

		return () => {
			window.removeEventListener('keydown', handleKeydown);
			window.removeEventListener('touchstart', handleTouchStart);
			window.removeEventListener('touchend', handleTouchEnd);
			window.removeEventListener('touchcancel', handleTouchCancel);
		};
	});
</script>

<!--
	Nothing renders until the sequence completes: no DOM node, no hint, no announcement. The
	obscurity is not the security boundary — the password is.
-->
{#if stage === 'letters'}
	<div class="gate-veil">
		<input
			bind:this={letterInput}
			class="gate-letter-input"
			type="text"
			inputmode="text"
			autocapitalize="off"
			autocorrect="off"
			spellcheck="false"
			maxlength="2"
			aria-label="Κωδικός πρόσβασης συντονισμού"
			value={letters}
			oninput={handleLetterInput}
			onblur={() => {
				if (stage === 'letters') reset();
			}}
		/>
	</div>
{/if}

{#if stage === 'password'}
	<AppModalArea title="" {reduceMotion} onClose={reset}>
		<form class="gate-form" onsubmit={submit}>
			<input
				bind:this={passwordInput}
				bind:value={password}
				type="password"
				autocomplete="current-password"
				enterkeyhint="go"
				aria-label="Κωδικός"
				disabled={submitting}
			/>
			{#if error}
				<p class="gate-error" aria-live="polite">{error}</p>
			{/if}
		</form>
	</AppModalArea>
{/if}

<style>
	.gate-veil {
		position: fixed;
		z-index: 1900;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--color-modal-backdrop);
	}

	.gate-letter-input {
		box-sizing: border-box;
		border: 1px solid var(--color-border);
		background: var(--color-surface);
		padding: 8px;
		width: 72px;
		color: inherit;
		font: inherit;
		text-align: center;
	}

	.gate-form {
		display: grid;
		gap: 8px;
	}

	.gate-form input {
		box-sizing: border-box;
		border: 1px solid var(--color-border);
		background: transparent;
		padding: 6px 8px;
		width: 100%;
		color: inherit;
		font: inherit;
	}

	.gate-error {
		margin: 0;
		color: var(--color-vibrant-coral);
		font-size: 13px;
		line-height: 18px;
	}
</style>
