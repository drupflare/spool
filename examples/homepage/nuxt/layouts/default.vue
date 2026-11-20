<script setup lang="ts">
const { data: about } = await useFetch('/api/about');
</script>

<template>
	<div>
		<nav>
			<NuxtLink to="/">Home</NuxtLink>
			<NuxtLink to="/news?page=1">News</NuxtLink>
			<NuxtLink to="/events?page=1">Events</NuxtLink>
			<NuxtLink to="/programs?page=1">Programs</NuxtLink>
			<NuxtLink to="/departments">Departments</NuxtLink>
			<NuxtLink to="/people">People</NuxtLink>
		</nav>
		<main data-spool-swap>
			<slot />
		</main>
		<footer>
			<nav>
				<NuxtLink
					v-for="page in about?.items"
					:key="page.slug"
					:to="`/about/${encodeURIComponent(page.slug)}`"
				>
					{{ page.title }}
				</NuxtLink>
			</nav>
		</footer>
	</div>
</template>
