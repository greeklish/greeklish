let lockCount = 0;
let previousOverflow = '';
let previousPriority = '';

/** Keep scrolling locked until every overlapping dialog/rail has released its own lock. */
export function acquireBodyScrollLock() {
	const style = document.body.style;
	if (lockCount === 0) {
		previousOverflow = style.getPropertyValue('overflow');
		previousPriority = style.getPropertyPriority('overflow');
		style.setProperty('overflow', 'hidden');
	}
	lockCount += 1;
	let released = false;

	return () => {
		if (released) return;
		released = true;
		lockCount -= 1;
		if (lockCount === 0) {
			if (previousOverflow) style.setProperty('overflow', previousOverflow, previousPriority);
			else style.removeProperty('overflow');
		}
	};
}
