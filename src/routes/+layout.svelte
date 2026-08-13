<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<style lang="scss">
		* {
			margin: 0;
			outline: none;
		}

		html, body {
			margin: 0;
			height: 100%;
			background: #0a0912;
			overflow: hidden;
		}
	</style>
</svelte:head>

{@render children()}
