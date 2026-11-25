<script lang="ts">
	import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom';
	import { ContextMenu, type IMenuOption } from '@svar-ui/svelte-menu';
	import { onDestroy, tick } from 'svelte';

	let { id, options }: { id: string; options: IMenuOption[] } = $props();
	let menu: ReturnType<typeof ContextMenu> | undefined;
	let cleanup: (() => void) | undefined;
	let generation = 0;
	const padding = 8;

	function clearPositioning() {
		generation++;
		cleanup?.();
		cleanup = undefined;
	}

	function close() {
		(menu as unknown as { show: (event: null) => void })?.show(null);
		clearPositioning();
	}

	export async function show(event: MouseEvent) {
		const anchor = event.currentTarget;
		if (!(anchor instanceof HTMLElement) || !menu || event.defaultPrevented) return;
		clearPositioning();
		const currentGeneration = generation;
		const keyboard = event.detail === 0;
		const reference = {
			contextElement: anchor,
			getBoundingClientRect() {
				// Keep pointer menus at the click even when opening the comments rail reflows
				// the feed. Keyboard activation follows the focused link instead.
				return keyboard
					? anchor.getBoundingClientRect()
					: new DOMRect(event.clientX, event.clientY, 0, 0);
			}
		};

		// SVAR owns opening, options and outside-click dismissal. Its position calculation
		// uses the document's bounds; Floating UI constrains the portalled menu to the viewport.
		(menu as unknown as { show: (event: MouseEvent) => void }).show(event);
		await tick();
		if (currentGeneration !== generation) return;
		const element = document.querySelector<HTMLElement>(`.${id}`);
		if (!element) return;
		element.setAttribute('role', 'menu');
		const items = [...element.querySelectorAll<HTMLElement>('.wx-option:not(.wx-disabled)')];
		for (const item of items) {
			item.setAttribute('role', 'menuitem');
			item.tabIndex = -1;
		}

		const update = async () => {
			const { x, y } = await computePosition(reference, element, {
				strategy: 'fixed',
				placement: 'bottom-start',
				middleware: [
					offset(4),
					flip({ padding }),
					shift({ padding, crossAxis: true }),
					size({
						padding,
						apply({ availableWidth, availableHeight }) {
							element.style.maxWidth = `${Math.max(0, availableWidth)}px`;
							element.style.maxHeight = `${Math.max(0, availableHeight)}px`;
						}
					})
				]
			});
			if (currentGeneration !== generation) return;
			element.style.setProperty('--feed-menu-x', `${x}px`);
			element.style.setProperty('--feed-menu-y', `${y}px`);
			element.style.setProperty('--feed-menu-visibility', 'visible');
		};
		await update();
		if (currentGeneration !== generation) return;
		const stop = autoUpdate(reference, element, update, { animationFrame: keyboard });
		if (keyboard) items[0]?.focus({ preventScroll: true });
		const onKeydown = (event: KeyboardEvent) => {
			if (event.key === 'Escape' || event.key === 'Tab') {
				if (event.key === 'Escape') {
					event.preventDefault();
					event.stopPropagation();
				}
				close();
				anchor.focus({ preventScroll: true });
				return;
			}
			const index = items.indexOf(document.activeElement as HTMLElement);
			if (index < 0 && document.activeElement !== anchor) return;
			if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
				event.preventDefault();
				event.stopPropagation();
				const next =
					event.key === 'Home'
						? 0
						: event.key === 'End'
							? items.length - 1
							: event.key === 'ArrowDown'
								? (index + 1) % items.length
								: (index - 1 + items.length) % items.length;
				items[next]?.focus({ preventScroll: true });
			} else if (index >= 0 && (event.key === 'Enter' || event.key === ' ')) {
				event.preventDefault();
				event.stopPropagation();
				items[index].click();
			}
		};
		window.addEventListener('keydown', onKeydown, true);
		cleanup = () => {
			stop();
			window.removeEventListener('keydown', onKeydown, true);
		};
	}

	onDestroy(clearPositioning);
</script>

<ContextMenu
	bind:this={menu}
	{options}
	at="point"
	css={`feed-comments-menu ${id}`}
	onclick={clearPositioning}
/>
