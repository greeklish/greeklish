import {
	autoUpdate,
	computePosition,
	flip,
	offset,
	shift,
	size,
	type Placement
} from '@floating-ui/dom';
import type { Action } from 'svelte/action';

export type TooltipOptions = {
	content: string;
	placement?: Placement;
	hoverDelay?: number;
};

const DEFAULT_HOVER_DELAY = 350;
const DEFAULT_PLACEMENT: Placement = 'bottom-start';
const VIEWPORT_PADDING = 8;
const MAX_WIDTH = 280;

let tooltipId = 0;

function addDescribedBy(node: HTMLElement, id: string) {
	const existing = node.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? [];
	if (!existing.includes(id)) {
		node.setAttribute('aria-describedby', [...existing, id].join(' '));
	}
}

function removeDescribedBy(node: HTMLElement, id: string) {
	const next = node
		.getAttribute('aria-describedby')
		?.split(/\s+/)
		.filter((value) => value && value !== id);

	if (next?.length) {
		node.setAttribute('aria-describedby', next.join(' '));
	} else {
		node.removeAttribute('aria-describedby');
	}
}

export const tooltip: Action<HTMLElement, TooltipOptions> = (node, options) => {
	const id = `app-tooltip-${++tooltipId}`;
	let currentOptions = options;
	let tooltipElement: HTMLElement | null = null;
	let cleanupAutoUpdate: (() => void) | null = null;
	let hoverTimeout: number | null = null;

	const clearHoverTimeout = () => {
		if (hoverTimeout == null) return;
		window.clearTimeout(hoverTimeout);
		hoverTimeout = null;
	};

	const updatePosition = async () => {
		const element = tooltipElement;
		if (!element) return;

		const { x, y } = await computePosition(node, element, {
			placement: currentOptions.placement ?? DEFAULT_PLACEMENT,
			strategy: 'fixed',
			middleware: [
				offset(6),
				flip({ padding: VIEWPORT_PADDING }),
				shift({ padding: VIEWPORT_PADDING }),
				size({
					padding: VIEWPORT_PADDING,
					apply({ availableWidth, availableHeight, elements }) {
						Object.assign(elements.floating.style, {
							maxWidth: `${Math.max(0, Math.min(MAX_WIDTH, availableWidth))}px`,
							maxHeight: `${Math.max(0, availableHeight)}px`
						});
					}
				})
			]
		});

		if (tooltipElement !== element) return;

		Object.assign(element.style, {
			left: `${x}px`,
			top: `${y}px`
		});
	};

	const show = () => {
		if (tooltipElement || !currentOptions.content) return;

		tooltipElement = document.createElement('div');
		tooltipElement.id = id;
		tooltipElement.className = 'app-tooltip';
		tooltipElement.role = 'tooltip';
		tooltipElement.textContent = currentOptions.content;
		tooltipElement.style.position = 'fixed';
		tooltipElement.style.left = '0';
		tooltipElement.style.top = '0';
		document.body.append(tooltipElement);

		addDescribedBy(node, id);
		document.addEventListener('keydown', handleKeydown);
		cleanupAutoUpdate = autoUpdate(node, tooltipElement, updatePosition);
	};

	const hide = () => {
		clearHoverTimeout();
		document.removeEventListener('keydown', handleKeydown);
		cleanupAutoUpdate?.();
		cleanupAutoUpdate = null;
		tooltipElement?.remove();
		tooltipElement = null;
		removeDescribedBy(node, id);
	};

	const handlePointerEnter = (event: PointerEvent) => {
		if (event.pointerType !== 'mouse') return;

		clearHoverTimeout();
		hoverTimeout = window.setTimeout(show, currentOptions.hoverDelay ?? DEFAULT_HOVER_DELAY);
	};

	const handlePointerLeave = () => {
		hide();
	};

	const handleFocus = () => {
		if (node.matches(':focus-visible')) {
			show();
		}
	};

	const handleBlur = () => {
		hide();
	};

	const handleKeydown = (event: KeyboardEvent) => {
		if (event.key === 'Escape' && tooltipElement) {
			hide();
		}
	};

	node.addEventListener('pointerenter', handlePointerEnter);
	node.addEventListener('pointerleave', handlePointerLeave);
	node.addEventListener('focus', handleFocus);
	node.addEventListener('blur', handleBlur);

	return {
		update(nextOptions) {
			currentOptions = nextOptions;

			if (!currentOptions.content) {
				hide();
				return;
			}

			if (tooltipElement) {
				tooltipElement.textContent = currentOptions.content;
				void updatePosition();
			}
		},
		destroy() {
			node.removeEventListener('pointerenter', handlePointerEnter);
			node.removeEventListener('pointerleave', handlePointerLeave);
			node.removeEventListener('focus', handleFocus);
			node.removeEventListener('blur', handleBlur);
			hide();
		}
	};
};
