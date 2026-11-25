import { acquireBodyScrollLock } from '$lib/body-scroll-lock';

const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type FocusTrapOptions = {
	/** When false the trap is inert, for a panel that is open but not modal. */
	active?: boolean;
	/** Also prevent the page behind from scrolling. */
	lockScroll?: boolean;
	onEscape?: () => void;
	background?: HTMLElement | null;
	returnFocus?: () => HTMLElement | null;
};

/** Keep modal focus and scrolling contained; nonmodal rails still support Escape. */
export function focusTrap(node: HTMLElement, options: FocusTrapOptions = {}) {
	let current: FocusTrapOptions = { active: true, lockScroll: true, ...options };
	const previouslyFocused = document.activeElement;
	let releaseScrollLock: (() => void) | null = null;
	let inertBackground: HTMLElement | null = null;
	let previousInert = false;

	function applyScrollLock() {
		const background = current.active ? (current.background ?? null) : null;
		if (inertBackground !== background) {
			if (inertBackground) inertBackground.inert = previousInert;
			inertBackground = background;
			if (background) {
				previousInert = background.inert;
				background.inert = true;
			}
		}
		if (current.lockScroll && releaseScrollLock === null) {
			releaseScrollLock = acquireBodyScrollLock();
			return;
		}

		if (!current.lockScroll && releaseScrollLock !== null) {
			releaseScrollLock();
			releaseScrollLock = null;
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.defaultPrevented) return;

		if (event.key === 'Escape') {
			if (!current.active && document.querySelector('[aria-modal="true"]')) return;
			event.preventDefault();
			event.stopPropagation();
			current.onEscape?.();
			return;
		}

		if (!current.active || event.key !== 'Tab') return;

		const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
			(element) => element.offsetParent !== null || element === document.activeElement
		);
		const first = focusable[0];
		const last = focusable.at(-1);

		if (!first || !last) {
			event.preventDefault();
			node.focus();
			return;
		}

		if (
			event.shiftKey &&
			(document.activeElement === first ||
				!focusable.includes(document.activeElement as HTMLElement))
		) {
			event.preventDefault();
			last.focus();
			return;
		}

		if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	applyScrollLock();
	window.addEventListener('keydown', handleKeydown);

	return {
		update(next: FocusTrapOptions) {
			current = { active: true, lockScroll: true, ...next };
			applyScrollLock();
		},
		destroy() {
			window.removeEventListener('keydown', handleKeydown);

			releaseScrollLock?.();

			if (inertBackground) inertBackground.inert = previousInert;
			const target = current.returnFocus?.() ?? previouslyFocused;
			if (target instanceof HTMLElement && target.isConnected) {
				target.focus({ preventScroll: true });
			}
		}
	};
}
