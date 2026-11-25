import type { Action } from 'svelte/action';

export type NumberWidthAnimationOptions = {
	enabled: boolean;
	timing: KeyframeAnimationOptions;
};

export const animateNumberWidth: Action<HTMLElement, NumberWidthAnimationOptions> = (
	node,
	options
) => {
	let currentOptions = options;
	let flow: HTMLElement | null = null;
	let widthAnimation: Animation | null = null;
	let previousWidth = node.getBoundingClientRect().width;

	const finishAnimation = (animation?: Animation) => {
		if (animation && widthAnimation !== animation) return;

		widthAnimation = null;
		node.style.width = '';
		previousWidth = flow?.getBoundingClientRect().width ?? node.getBoundingClientRect().width;
	};

	const handleWidthChange = () => {
		if (!flow) return;

		const targetWidth = flow.getBoundingClientRect().width;
		const startWidth = widthAnimation ? node.getBoundingClientRect().width : previousWidth;

		widthAnimation?.cancel();
		node.style.width = `${targetWidth}px`;

		if (!currentOptions.enabled || Math.abs(targetWidth - startWidth) < 0.5) {
			finishAnimation();
			return;
		}

		const animation = node.animate(
			{ width: [`${startWidth}px`, `${targetWidth}px`] },
			currentOptions.timing
		);
		widthAnimation = animation;
		animation.finished.then(() => finishAnimation(animation)).catch(() => {});
	};

	const resizeObserver = new ResizeObserver(handleWidthChange);

	const attachFlow = () => {
		const nextFlow = node.querySelector<HTMLElement>('number-flow-svelte');
		if (nextFlow === flow) return;

		if (flow) resizeObserver.unobserve(flow);
		flow = nextFlow;
		if (flow) resizeObserver.observe(flow);
		previousWidth = node.getBoundingClientRect().width;
	};

	const mutationObserver = new MutationObserver(attachFlow);
	mutationObserver.observe(node, { childList: true });
	attachFlow();

	return {
		update(nextOptions) {
			const wasEnabled = currentOptions.enabled;
			currentOptions = nextOptions;

			if (!currentOptions.enabled) {
				widthAnimation?.cancel();
				finishAnimation();
			} else if (!wasEnabled) {
				previousWidth = node.getBoundingClientRect().width;
			}
		},
		destroy() {
			mutationObserver.disconnect();
			resizeObserver.disconnect();
			widthAnimation?.cancel();
		}
	};
};
