export default defineNuxtConfig({
	ssr: true,
	devtools: { enabled: false },
	compatibilityDate: '2026-11-18',
	modules: ['@drupflare/spool/nuxt'],
	spool: { spool: './server/spool.ts' },
	nitro: { esbuild: { options: { target: 'es2022' } } }
});
