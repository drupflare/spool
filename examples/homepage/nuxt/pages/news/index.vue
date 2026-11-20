<script setup lang="ts">
useHead({ title: 'News' });
const route = useRoute();
const { data } = await useFetch('/api/news', { query: route.query });
if (!data.value) throw createError({ statusCode: 404, statusMessage: 'Not found' });
</script>

<template>
	<div>
		<h1>News</h1>
		<p>
			{{ data?.query.total }} stories, page {{ data?.query.page }} of {{ data?.query.pages }}
		</p>
		<ul>
			<li
				v-for="row in data?.items"
				:key="row.slug"
			>
				<NuxtLink :to="`/news/${encodeURIComponent(row.slug)}`">{{ row.title }}</NuxtLink>
			</li>
		</ul>
	</div>
</template>
