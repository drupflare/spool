import { describe, expect, it } from 'vitest';
import { runConformance, type Check } from '../../scripts/conformance';
import { createSpool, defineDataset, defineRoute, type Spool } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';

type Row = { id: string; title: string };

/** a dataset backend: rows, a cursor and tombstones for the rows that left */
class Shelf {
	rows = new Map<string, Row>();
	cursor = 0;
	tombs: Array<{ key: string; cursor: number }> = [];

	constructor(count: number) {
		for (let i = 0; i < count; i++) {
			const id = `c${String(i).padStart(5, '0')}`;
			this.rows.set(id, { id, title: `Item ${i}` });
		}
	}

	remove(key: string) {
		if (!this.rows.delete(key)) return;
		this.cursor += 1;
		this.tombs.push({ key, cursor: this.cursor });
	}

	dataset() {
		return defineDataset<Row>('shelf', {
			scope: 'public',
			key: (row) => row.id,
			seed: () => [...this.rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
			read: (ids) => ids.flatMap((id) => this.rows.get(id) ?? []),
			changes: (since) =>
				since > this.cursor
					? 'reset'
					: {
							cursor: this.cursor,
							puts: [],
							deletes: this.tombs.filter((t) => t.cursor > since)
						},
			horizon: () => 0,
			head: () => ({ cursor: this.cursor }),
			schema: 'v1',
			maxRows: 1000,
			maxBytes: 1_000_000
		});
	}
}

const page = (title: string) => `<html><head></head><body>{{title}} ${title}</body></html>`;

const about = defineRoute('/about', {
	strategy: 'template',
	template: { source: page('about') },
	load: () => ({ title: 'About' })
});

const me = defineRoute('/me', {
	strategy: 'template',
	scope: 'principal',
	template: { source: page('me') },
	load: (ctx) => ({ title: ctx.identity?.principal ?? '' })
});

const PRINCIPAL = { cookie: 'who=alice' };

function build(shelf: Shelf): Spool {
	return createSpool({
		routes: [about, me],
		store: memoryStore(),
		datasets: [shelf.dataset()],
		identity: {
			secret: 'conformance-secret',
			resolve: (request) => {
				const who = /who=([a-z]+)/.exec(request.headers.get('cookie') ?? '');
				return who?.[1] ? { principal: who[1] } : null;
			}
		}
	});
}

type Edit = (url: URL, response: Response) => Promise<Response> | Response;

/** the server as a fetch function; `mutate` deletes a row between the seed and the patch */
function serve(spool: Spool, shelf: Shelf, edit: Edit = (_, response) => response, mutate = true) {
	let mutated = false;
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (
			mutate &&
			!mutated &&
			url.pathname === '/.spool/dataset' &&
			url.searchParams.has('since')
		) {
			mutated = true;
			shelf.remove('c00001');
		}
		const response = await spool.handle(request, () => new Response('app', { status: 404 }));
		return edit(url, response);
	}) as typeof fetch;
}

/** the response with its JSON body changed and its headers edited */
async function rewrite(
	response: Response,
	change: (body: Record<string, unknown>) => Record<string, unknown>,
	head: (headers: Headers) => void = () => {}
): Promise<Response> {
	const body = change((await response.json()) as Record<string, unknown>);
	const headers = new Headers(response.headers);
	headers.delete('content-length');
	head(headers);
	return new Response(JSON.stringify(body), { status: response.status, headers });
}

const failed = (checks: Check[]) => checks.filter((c) => !c.ok && !c.skipped).map((c) => c.id);
const skipped = (checks: Check[]) => checks.filter((c) => c.skipped).map((c) => c.id);

const isJson = (response: Response) =>
	(response.headers.get('content-type') ?? '').startsWith('application/json');

describe('runConformance against createSpool', () => {
	it('passes every check that can run, with a public dataset, a template and a principal route', async () => {
		const shelf = new Shelf(5);
		const result = await runConformance({
			base: 'https://site.test',
			fetch: serve(build(shelf), shelf),
			datasets: ['shelf'],
			principal: PRINCIPAL
		});
		expect(failed(result.checks)).toEqual([]);
		expect(skipped(result.checks)).toEqual(['error-500']);
		expect(result.ok).toBe(true);
		const tombstone = result.checks.find((c) => c.id === 'dataset-tombstone:shelf');
		expect(tombstone?.detail).toBe('1 deletes applied; rows match the proof');
	});

	it('skips the dataset checks when no dataset is named, and does not call them ok', async () => {
		const shelf = new Shelf(3);
		const result = await runConformance({
			base: 'https://site.test',
			fetch: serve(build(shelf), shelf)
		});
		const datasetChecks = result.checks.filter((c) => c.id.startsWith('dataset-'));
		expect(datasetChecks.map((c) => c.id)).toEqual([
			'dataset-seed',
			'dataset-proof',
			'dataset-changes',
			'dataset-tombstone'
		]);
		for (const check of datasetChecks) {
			expect(check.skipped).toBe(true);
			expect(check.ok).toBe(false);
		}
		expect(skipped(result.checks)).toContain('principal-no-store');
		expect(result.ok).toBe(true);
	});

	it('fails a server that is not a spool server without throwing', async () => {
		const result = await runConformance({
			base: 'https://site.test',
			fetch: (async () => new Response('hello')) as unknown as typeof fetch
		});
		expect(result.ok).toBe(false);
		expect(failed(result.checks)).toContain('sync-from');
	});

	describe('a fake server that breaks one requirement fails exactly that check', () => {
		const cases: Array<[string, (shelf: Shelf, spool: Spool) => typeof fetch, string[]]> = [
			[
				'a sync answer without protocol',
				(shelf, spool) =>
					serve(spool, shelf, async (url, response) =>
						url.pathname === '/.spool/sync' &&
						response.status === 200 &&
						isJson(response)
							? rewrite(response, (body) => {
									delete body['protocol'];
									return body;
								})
							: response
					),
				['protocol-integer']
			],
			[
				'a Spool-Vector header of 16 digits',
				(shelf, spool) =>
					serve(spool, shelf, (url, response) => {
						if (url.pathname !== '/.spool/sync') return response;
						const headers = new Headers(response.headers);
						headers.set('spool-vector', '1234567890123456');
						return new Response(response.body, { status: response.status, headers });
					}),
				['header-grammar']
			],
			[
				'JSON answers without Cache-Control no-store',
				(shelf, spool) =>
					serve(spool, shelf, async (_, response) => {
						const isPrivate = (response.headers.get('cache-control') ?? '').includes(
							'private'
						);
						if (!isJson(response) || isPrivate) return response;
						const text = await response.text();
						const headers = new Headers(response.headers);
						headers.delete('cache-control');
						return new Response(text, { status: response.status, headers });
					}),
				['no-store']
			],
			[
				'an unknown /.spool/ path answering 200',
				(shelf, spool) =>
					serve(spool, shelf, (url, response) => {
						if (url.pathname !== '/.spool/nope') return response;
						return new Response('{"error":"not found"}', {
							status: 200,
							headers: {
								'content-type': 'application/json',
								'cache-control': 'no-store'
							}
						});
					}),
				['not-found']
			],
			[
				'a patch that drops its tombstones',
				(shelf, spool) =>
					serve(
						spool,
						shelf,
						(url, response) =>
							url.pathname === '/.spool/dataset' &&
							url.searchParams.has('since') &&
							response.status === 200
								? rewrite(response, (body) => ({ ...body, deletes: [] }))
								: response,
						true
					),
				['dataset-tombstone:shelf']
			],
			[
				'a seed proof off by one row',
				(shelf, spool) =>
					serve(spool, shelf, (url, response) =>
						url.pathname === '/.spool/dataset' &&
						!url.searchParams.has('since') &&
						response.status === 200
							? rewrite(response, (body) => {
									const proof = body['proof'] as {
										count: number;
										digest: string;
									};
									return { ...body, proof: { ...proof, count: proof.count + 1 } };
								})
							: response
					),
				['dataset-proof:shelf']
			]
		];

		it.each(cases)('%s', async (_, make, expected) => {
			const shelf = new Shelf(5);
			const result = await runConformance({
				base: 'https://site.test',
				fetch: make(shelf, build(shelf)),
				datasets: ['shelf'],
				principal: PRINCIPAL
			});
			expect(failed(result.checks)).toEqual(expected);
			expect(result.ok).toBe(false);
		});
	});
});
