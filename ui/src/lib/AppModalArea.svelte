<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { fade } from 'svelte/transition';
	import { acquireBodyScrollLock } from '$lib/body-scroll-lock';

	let {
		title,
		reduceMotion = false,
		onClose,
		children
	}: {
		title: string;
		reduceMotion?: boolean;
		onClose: () => void;
		children: Snippet;
	} = $props();

	let dialog: HTMLDivElement;

	function close() {
		onClose();
	}

	function handleWindowClick(event: MouseEvent) {
		if (event.target instanceof HTMLElement && event.target.classList.contains('wx-modal')) {
			close();
		}
	}

	function handleWindowKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			close();
			return;
		}

		if (event.key !== 'Tab') return;

		const focusable = Array.from(
			dialog.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
			)
		);
		const first = focusable[0];
		const last = focusable.at(-1);

		if (!first || !last) {
			event.preventDefault();
			dialog.focus();
		} else if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	onMount(() => {
		const previouslyFocused = document.activeElement;
		const releaseScrollLock = acquireBodyScrollLock();
		dialog.focus();

		return () => {
			releaseScrollLock();
			if (previouslyFocused instanceof HTMLElement) {
				previouslyFocused.focus();
			}
		};
	});
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKeydown} />

<div class="wx-modal" transition:fade={{ duration: reduceMotion ? 0 : 100 }}>
	<div class="wx-window">
		<div
			bind:this={dialog}
			class="app-modal"
			role="dialog"
			aria-modal="true"
			aria-label={title}
			tabindex="-1"
		>
			<header class="app-modal-header">
				<h2>{title}</h2>
				<button class="app-modal-close" type="button" aria-label="Close" onclick={close}>
					&times;
				</button>
			</header>
			<div class="app-modal-content">
				{@render children()}
			</div>
		</div>
	</div>
</div>

<style>
	.wx-modal {
		position: fixed;
		z-index: var(--wx-modal-z-index);
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		overflow: hidden;
		background: var(--wx-modal-backdrop);
		padding: 20px 0;
	}

	.wx-window {
		box-sizing: border-box;
		min-width: var(--wx-modal-width);
		max-height: calc(100vh - 40px);
		overflow: hidden;
		border: var(--wx-modal-border);
		border-radius: var(--wx-modal-border-radius);
		background: var(--wx-modal-background);
		box-shadow: var(--wx-modal-shadow);
	}

	.app-modal {
		box-sizing: border-box;
		width: min(400px, calc(100vw - 32px));
		max-height: calc(100vh - 42px);
		overflow-y: auto;
		background: var(--wx-modal-background, #fff);
		padding: 20px;
	}

	.app-modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 20px;
	}

	h2 {
		margin: 0;
		font-size: 20px;
		line-height: 1.2;
	}

	.app-modal-close {
		display: inline-grid;
		flex: 0 0 auto;
		place-items: center;
		width: 32px;
		height: 32px;
		border: 0;
		background: transparent;
		padding: 0;
		color: inherit;
		font-size: 26px;
		line-height: 1;
		cursor: pointer;
	}

	.app-modal-close:hover {
		color: var(--color-cerulean);
	}

	.app-modal-content {
		display: grid;
		gap: 16px;
	}
</style>
