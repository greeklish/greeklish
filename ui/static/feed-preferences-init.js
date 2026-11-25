// Runs in the prerendered head before the application hydrates.
// Only change presentation here: hydration still needs the original DOM order.
(() => {
	try {
		const saved = JSON.parse(localStorage.getItem('greeklish-feed-preferences') || 'null');
		if (!saved || saved.version !== 1) return;
		const sources = JSON.parse(
			document.querySelector('meta[name="feed-sources"]')?.getAttribute('content') || '[]'
		);
		/** @param {unknown} values */
		const valid = (values) =>
			Array.isArray(values) ? values.filter((value) => sources.includes(value)) : [];
		const order = [...new Set([...valid(saved.order), ...sources])];
		const hidden = new Set(valid(saved.hiddenSources));
		const visible = order.filter((topic) => !hidden.has(topic));
		const rules = [];
		for (const [index, topic] of order.entries()) {
			const id = CSS.escape(`feed-${topic}`);
			const selectors = `#${id}, .source-links a[href="#${id}"]`;
			rules.push(`${selectors} { order: ${index}; ${hidden.has(topic) ? 'display: none;' : ''} }`);
		}
		for (const item of Array.isArray(saved.hiddenTopics) ? saved.hiddenTopics : []) {
			if (
				item &&
				sources.includes(item.topic) &&
				typeof item.externalId === 'string' &&
				item.externalId &&
				typeof item.title === 'string'
			) {
				rules.push(
					`#${CSS.escape(`feed-${item.topic}`)} li[data-feed-item-id="${CSS.escape(item.externalId)}"] { display: none; }`
				);
			}
		}
		// The DOM still has the default order, so override its nth-child layout
		// until Svelte has applied the saved order and visibility to the DOM.
		const wide = visible.indexOf('x-trends') % 3 === 0;
		rules.push(`@container app-main (min-width: 1680px) {
			#feed-x-trends { grid-column: ${wide ? '1 / -1' : 'auto'}; }
			#feed-x-trends .feed-list-horizontal {
				display: ${wide ? 'flex' : 'block'};
				overflow-x: ${wide ? 'auto' : 'clip'};
				padding-bottom: ${wide ? '8px' : '0'};
			}
			#feed-x-trends .feed-list-horizontal li {
				width: ${wide ? 'max-content' : 'auto'};
				max-width: ${wide ? 'min(70vw, 520px)' : '100%'};
				margin: ${wide ? '0' : '0 6px 8px 0'};
			}
			#feed-x-trends .item-title { white-space: ${wide ? 'nowrap' : 'normal'}; }
		}`);
		const style = document.createElement('style');
		style.id = 'feed-preferences-initial';
		style.textContent = rules.join('\n');
		document.head.append(style);
	} catch {
		// Unavailable or malformed storage leaves the prerendered defaults usable.
	}
})();
