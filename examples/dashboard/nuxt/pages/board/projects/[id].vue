<template>
	<div v-if="project">
		<h1>{{ project.name }}</h1>
		<p>{{ project.open }} open, {{ project.done }} done, {{ project.overdue }} overdue</p>
		<p><NuxtLink to="/">Board</NuxtLink></p>
	</div>
	<p v-else>Not found.</p>
</template>

<script setup lang="ts">
type Project = { id: string; name: string; open: number; done: number; overdue: number };

const route = useRoute();
const { data: project } = await useFetch<Project>(() => `/projects/${String(route.params.id)}`);
</script>
