<template>
	<div>
		<h1>Board</h1>
		<ul>
			<li
				v-for="task in tasks"
				:key="task.id"
			>
				<NuxtLink :to="`/board/tasks/${task.id}`">{{ task.title }}</NuxtLink
				>, {{ task.status }},
				<NuxtLink :to="`/board/projects/${task.project}`">{{
					projectName(task.project)
				}}</NuxtLink>
			</li>
		</ul>
		<p>
			<NuxtLink
				v-for="project in projects"
				:key="project.id"
				:to="`/board/projects/${project.id}`"
			>
				{{ project.name }}
			</NuxtLink>
		</p>
		<form @submit.prevent="create">
			<label
				>Title
				<input
					v-model="draft.title"
					required
			/></label>
			<label>
				Project
				<select v-model="draft.project">
					<option
						v-for="project in projects"
						:key="project.id"
						:value="project.id"
					>
						{{ project.name }}
					</option>
				</select>
			</label>
			<label
				>Due
				<input
					v-model="draft.due"
					type="date"
					required
			/></label>
			<button>Create task</button>
		</form>
		<p v-if="error">{{ error }}</p>
	</div>
</template>

<script setup lang="ts">
type Task = { id: string; project: string; title: string; status: string };

const projects = [
	{ id: 'site', name: 'Website refresh' },
	{ id: 'app', name: 'Campus app' }
];

const { data, refresh } = await useFetch<{ tasks: Task[] }>('/tasks', {
	default: () => ({ tasks: [] })
});
const tasks = computed(() => data.value.tasks);

const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? id;

const draft = reactive({ title: '', project: 'site', due: '' });
const error = ref('');

async function create() {
	error.value = '';
	try {
		await $fetch('/tasks', { method: 'POST', body: { ...draft } });
		draft.title = '';
		await refresh();
	} catch {
		error.value = 'Sign in as a member of the project first.';
	}
}
</script>
