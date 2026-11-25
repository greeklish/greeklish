(() => {
	const root = document.documentElement;
	let storedMode;
	try {
		storedMode = localStorage.getItem('mode-watcher-mode') || 'system';
	} catch {
		storedMode = 'system';
	}
	if (!['system', 'light', 'dark'].includes(storedMode)) storedMode = 'system';
	const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
	const isLight = storedMode === 'light' || (storedMode === 'system' && !prefersDark);

	root.classList.toggle('dark', !isLight);
	root.style.colorScheme = isLight ? 'light' : 'dark';
})();
