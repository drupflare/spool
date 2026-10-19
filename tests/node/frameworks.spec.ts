import { HttpRequest } from '@azure/functions';
import { getTestServer } from '@google-cloud/functions-framework/testing';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { toNodeListener } from '../../src/node/listener';
import { closeServers, exercise, listen, overFetch, overHttp } from './exercise';
import { handler as azure } from './readme/azure';
import { onRequest as cloudflarePages } from './readme/cloudflare-pages';
import { app as fastify } from './readme/fastify';
import './readme/google-cloud';
import { server as hapi } from './readme/hapi';
import ittyRouter from './readme/itty-router';
import { app as koa } from './readme/koa';
import { handler as lambda } from './readme/lambda';
import { bootstrap } from './readme/nest';
import netlifyEdge from './readme/netlify-edge';
import netlifyFunctions from './readme/netlify-functions';
import { page } from './readme/routes';

afterEach(closeServers);

type LambdaResult = {
	statusCode: number;
	headers?: Record<string, string>;
	body?: string;
	isBase64Encoded?: boolean;
};

function functionUrlEvent(path: string) {
	const [rawPath = '/', rawQueryString = ''] = path.split('?');
	return {
		version: '2.0',
		routeKey: '$default',
		rawPath,
		rawQueryString,
		headers: { host: 'site.test' },
		requestContext: {
			domainName: 'site.test',
			http: { method: 'GET', path: rawPath, protocol: 'HTTP/1.1', sourceIp: '1.1.1.1' }
		},
		isBase64Encoded: false
	};
}

describe('frameworks that give a Node request and response', () => {
	it('Fastify, through reply.send(Response)', async () => {
		await fastify.listen({ port: 0, host: '127.0.0.1' });
		try {
			const { port } = fastify.server.address() as AddressInfo;
			await exercise(overHttp(`http://127.0.0.1:${port}`));
		} finally {
			await fastify.close();
		}
	});

	it('Koa, with ctx.respond off for what spool writes', async () => {
		await exercise(overHttp(await listen(createServer(koa.callback()))));
	});

	it('hapi, through onRequest and h.abandon', async () => {
		await hapi.start();
		try {
			await exercise(overHttp(hapi.info.uri));
		} finally {
			await hapi.stop();
		}
	});

	it('NestJS on Express, through app.use and a controller', async () => {
		const app = await bootstrap();
		await app.listen(0, '127.0.0.1');
		try {
			const { port } = app.getHttpServer().address() as AddressInfo;
			await exercise(overHttp(`http://127.0.0.1:${port}`));
		} finally {
			await app.close();
		}
	});

	it('Google Cloud Functions, through the Functions Framework test server', async () => {
		await exercise(
			overHttp(await listen(getTestServer('spool') as ReturnType<typeof createServer>))
		);
	});
});

describe('frameworks and hosts that give a Fetch request', () => {
	it('itty-router continues past a handler that returns undefined', async () => {
		await exercise(overFetch((request) => ittyRouter.fetch(request)));
		const other = await ittyRouter.fetch(new Request('https://site.test/other'));
		expect(other).toBeUndefined();
	});

	it('Azure Functions converts an HttpRequest and returns an HttpResponseInit', async () => {
		await exercise(async (path) => {
			const result = await azure(
				new HttpRequest({ url: `https://site.test${path}`, method: 'GET' })
			);
			return new Response(result.body as ArrayBuffer, {
				status: result.status,
				headers: result.headers as HeadersInit
			});
		});
	});

	it('AWS Lambda, through the Hono adapter and a Function URL event', async () => {
		await exercise(async (path) => {
			const result = (await lambda(
				functionUrlEvent(path) as never,
				{} as never
			)) as LambdaResult;
			const body = result.isBase64Encoded
				? Buffer.from(result.body ?? '', 'base64')
				: (result.body ?? '');
			return new Response(body, { status: result.statusCode, headers: result.headers });
		});
	});

	it('Cloudflare Pages Functions, Netlify Functions and Netlify Edge Functions take a stand-in context', async () => {
		await exercise(
			overFetch((request) => cloudflarePages({ request, next: async () => page(request) }))
		);
		await exercise(overFetch((request) => netlifyFunctions(request, {} as never)));
		await exercise(
			overFetch((request) =>
				netlifyEdge(request, { next: async () => page(request) } as never)
			)
		);
		expect(toNodeListener).toBeTypeOf('function');
	});
});
