import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import {
	decodeEnvelope,
	defineRoute,
	equivalent,
	interpretTemplate
} from '../../src/protocol/index';
import proxyReadme from '../fixtures/readme/proxy-workers';
import readme from '../fixtures/readme/workers';
import { NODE_PAGE } from '../fixtures/worker';

const route = defineRoute('/node/:id', {
	strategy: 'template',
	template: {
		source: '<!doctype html><html><head><title>Node {{id}}</title></head><body><h1>Node {{id}}</h1></body></html>'
	},
	load: () => null
});

describe('a Workers module fetch handler wrapped with spool', () => {
	it('decorates the app response with the envelope and the client tag', async () => {
		const response = await SELF.fetch('https://site.test/node/5');
		expect(response.status).toBe(200);
		const envelope = decodeEnvelope(response.headers);
		expect(envelope.artifact?.id).toBe('/node/5');
		expect(envelope.artifact?.deps).toEqual(['node:5']);
		expect(await response.text()).toContain('data-spool-client');
	});

	it('answers /.spool/artifact and /.spool/sync from the Durable Object store', async () => {
		const artifact = await SELF.fetch('https://site.test/.spool/artifact?path=/node/5');
		expect(artifact.status).toBe(200);
		const sync = await SELF.fetch('https://site.test/.spool/sync?from=0');
		expect(((await sync.json()) as { reset: boolean }).reset).toBe(false);
	});

	it('serves the worker script', async () => {
		const response = await SELF.fetch('https://site.test/spool-sw.js');
		expect(response.headers.get('cache-control')).toBe('max-age=86400');
	});

	it('renders the same page from the artifact as the app does', async () => {
		const artifact = (await (
			await SELF.fetch('https://site.test/.spool/artifact?path=/node/5')
		).json()) as { body: { data: unknown } };
		const local = interpretTemplate(route.template!, artifact.body.data);
		expect(equivalent(local, NODE_PAGE('5')).equal).toBe(true);
	});
});

describe('the README Workers proxy example', () => {
	it('forwards to its origin, tags the page and bumps the Durable Object vector on a purge', async () => {
		const asked: string[] = [];
		const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			asked.push(new URL(new Request(input).url).pathname);
			return new Response('<!doctype html><html><head></head><body>proxied</body></html>', {
				headers: { 'content-type': 'text/html', 'cache-tag': 'node:3,menu' }
			});
		});
		try {
			const secured = { ...env, PURGE_SECRET: 'workers-secret' };
			const page = await proxyReadme.fetch(new Request('https://site.test/p/3'), secured);
			expect(await page.text()).toContain('data-spool-client');
			expect(decodeEnvelope(page.headers).artifact?.deps).toEqual(['node:3', 'menu']);
			const worker = await proxyReadme.fetch(
				new Request('https://site.test/spool-sw.js'),
				secured
			);
			expect(worker.status).toBe(200);
			expect(asked).toEqual(['/p/3']);

			const before = await env.SPOOL_VERSIONS.getByName('spool').cursor();
			const purge = await proxyReadme.fetch(
				new Request('https://site.test/.spool/purge', {
					method: 'POST',
					headers: { authorization: 'Bearer workers-secret' },
					body: JSON.stringify({ tags: ['node:3'] })
				}),
				secured
			);
			expect(purge.status).toBe(200);
			expect(await env.SPOOL_VERSIONS.getByName('spool').cursor()).toBe(before + 1);
		} finally {
			spy.mockRestore();
		}
	});
});

describe('the README Workers example', () => {
	it('wraps the app with spool over the Durable Object store', async () => {
		const response = await readme.fetch(new Request('https://site.test/node/8'), env);
		expect(decodeEnvelope(response.headers).artifact?.deps).toEqual(['node:8']);
		const worker = await readme.fetch(new Request('https://site.test/spool-sw.js'), env);
		expect(worker.headers.get('cache-control')).toBe('max-age=86400');
	});
});
