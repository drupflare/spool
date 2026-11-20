<script setup lang="ts">
useHead({ title: 'Larkspur College' });
const { data } = await useFetch('/api/home');
</script>

<template>
	<div>
		<h1>Larkspur College</h1>
		<section>
			<h2>Latest news</h2>
			<ul>
				<li
					v-for="row in data?.news"
					:key="row.slug"
				>
					<NuxtLink :to="`/news/${encodeURIComponent(row.slug)}`">{{
						row.title
					}}</NuxtLink>
				</li>
			</ul>
		</section>
		<section>
			<h2>Next events</h2>
			<ul>
				<li
					v-for="row in data?.events"
					:key="row.id"
				>
					<NuxtLink :to="`/events/${encodeURIComponent(row.id)}`">{{
						row.title
					}}</NuxtLink
					>,
					{{ row.starts }}
				</li>
			</ul>
		</section>
	</div>
</template>
