<script lang="ts">
	import Icon from '$lib/Icon.svelte';
	import { icons, type IconName } from '$lib/icons';

	const iconNames = Object.keys(icons) as IconName[];
</script>

<svelte:head>
	<title>Icons</title>
	<meta name="robots" content="noindex, follow" />
</svelte:head>

<main class="icons-page">
	<h1>Icons</h1>

	<ul class="icons-list">
		{#each iconNames as name (name)}
			<li>
				<Icon {name} size={24} />
				<span>{name}</span>
			</li>
		{/each}
	</ul>
</main>

<style>
	.icons-page {
		width: min(720px, calc(100vw - 32px));
		margin: 40px auto;
	}

	.icons-page h1 {
		margin: 0 0 24px;
		font-size: 28px;
		line-height: 1.1;
	}

	.icons-list {
		display: grid;
		gap: 12px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.icons-list li {
		display: grid;
		grid-template-columns: 32px 1fr;
		align-items: center;
		gap: 12px;
		min-height: 40px;
		border-bottom: 1px solid var(--color-border);
		font-size: 14px;
		line-height: 20px;
	}
</style>
