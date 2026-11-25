import { flushSync, mount } from 'svelte';
import ModeratorGate from '../../src/lib/ModeratorGate.svelte';

flushSync(() => mount(ModeratorGate, { target: document.body, props: { reduceMotion: true } }));
document.body.dataset.ready = 'true';

// These listeners run after the gate's listeners, before any queued microtasks.
window.gateEvents = [];
for (const type of ['touchend', 'pointercancel', 'input']) {
	window.addEventListener(type, (event) => {
		window.gateEvents.push({
			type,
			prevented: event.defaultPrevented,
			focused: document.activeElement?.getAttribute('aria-label')
		});
	});
}
