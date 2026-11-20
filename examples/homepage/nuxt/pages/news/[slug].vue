<script setup lang="ts">
const route = useRoute();
const { data: row } = await useFetch(
	() => `/api/news/${encodeURIComponent(String(route.params.slug))}`
);
if (!row.value) throw createError({ statusCode: 404, statusMessage: 'Not found' });
useHead({ title: row.value.title });
</script>

<template>
	<div>
		<h1>{{ row?.title }}</h1>
		<p>{{ row?.published }}</p>
		<p><NuxtLink to="/news?page=1">All news</NuxtLink></p>
	</div>
</template>
