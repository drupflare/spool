<script setup lang="ts">
useHead({ title: 'Events' });
const route = useRoute();
const { data } = await useFetch('/api/events', { query: route.query });
if (!data.value) throw createError({ statusCode: 404, statusMessage: 'Not found' });
</script>

<template>
	<div>
		<h1>Events</h1>
		<p>
			{{ data?.query.total }} events, page {{ data?.query.page }} of {{ data?.query.pages }}
		</p>
		<ul>
			<li
				v-for="row in data?.items"
				:key="row.id"
			>
				<NuxtLink :to="`/events/${encodeURIComponent(row.id)}`">{{ row.title }}</NuxtLink
				>, {{ row.starts }}, {{ row.place }}
			</li>
		</ul>
	</div>
</template>
