import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import Icons from 'unplugin-icons/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	define: {
		__GREEKLISH_APP_VERSION__: JSON.stringify(process.env.PUBLIC_APP_VERSION || 'development')
	},
	build: {
		cssMinify: true,
		minify: 'terser'
	},
	server: {
		// Production serves the API same-origin through Caddy. Proxying in development keeps
		// `resolveApiBaseUrl()` on the same branch in both.
		proxy: {
			'/api': 'http://127.0.0.1:3000'
		}
	},
	plugins: [
		tailwindcss(),
		sveltekit(),
		Icons({
			compiler: 'svelte'
		})
	]
});
