<script setup lang="ts">
useHead({ title: 'Programs' });
const route = useRoute();
const { data } = await useFetch('/api/programs', { query: route.query });
if (!data.value) throw createError({ statusCode: 404, statusMessage: 'Not found' });
</script>

<template>
	<div>
		<h1>Programs</h1>
		<p>
			{{ data?.query.total }} programs, page {{ data?.query.page }} of {{ data?.query.pages }}
		</p>
		<ul>
			<li
				v-for="row in data?.items"
				:key="row.id"
			>
				<NuxtLink :to="`/programs/${encodeURIComponent(row.id)}`">{{ row.name }}</NuxtLink>
				({{ row.level }})
			</li>
		</ul>
	</div>
</template>
