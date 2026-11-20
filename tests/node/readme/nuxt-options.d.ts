import type { SpoolNuxtOptions } from '../../../src/nuxt/index';

declare module '@nuxt/schema' {
	interface NuxtConfig {
		spool?: SpoolNuxtOptions;
	}
}
