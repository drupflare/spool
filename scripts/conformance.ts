import { PROTOCOL_VERSION, parseArtifact } from '../src/protocol/artifact';
import { applyChanges, parseDatasetResponse, type DatasetResponse } from '../src/protocol/dataset';
import { HEADERS } from '../src/protocol/envelope';
import { setProof, type Plain, type SetProof } from '../src/protocol/query';
import { parseSyncResponse } from '../src/protocol/sync';
import { isMain } from './measure/lib';

/** one requirement's result; `skipped` means the kit could not exercise it, and `ok` is then false */
export type Check = {
	id: string;
	requirement: string;
	ok: boolean;
	skipped?: true;
	detail: string;
};

export type ConformanceOptions = {
	/** the origin to check, such as `https://site.example` */
	base: string;
	/** the fetch to call; the global one when absent */
	fetch?: typeof fetch;
	/** dataset names to check; without any, the dataset checks are skipped */
	datasets?: readonly string[];
	/** headers that make the request a principal, for the principal artifact check */
	principal?: Record<string, string>;
};

/** `ok` is true when no check failed; skipped checks do not count as failures */
export type ConformanceResult = { checks: Check[]; ok: boolean };

type Outcome = { ok: boolean; skipped?: true; detail: string };
type Probe = { status: number; headers: Headers; text: string; json: unknown };
type RunInit = { method?: string; body?: string; headers?: Record<string, string> };
type Run = (path: string, init?: RunInit) => Promise<Probe>;
type Seed = {
	rows: Map<string, Plain>;
	cursor: number;
	schema: string;
	proof: SetProof;
	computed: SetProof;
	pages: number;
};

const INTEGER = /^\d{1,15}$/;
const MAX_PAGES = 10_000;
const TIMEOUT_MS = 15_000;
const DECLINED = 'declined';

const pass = (detail: string): Outcome => ({ ok: true, detail });
const fail = (detail: string): Outcome => ({ ok: false, detail });
const skip = (detail: string): Outcome => ({ ok: false, skipped: true, detail });

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** the body with `protocol` set, so a shared parser checks the rest of the shape */
function withProtocol(body: unknown): unknown {
	return typeof body === 'object' && body !== null
		? { ...body, protocol: PROTOCOL_VERSION }
		: body;
}

const isJson = (probe: Probe) =>
	(probe.headers.get('content-type') ?? '').startsWith('application/json');

const errorIs = (json: unknown, message: string) =>
	JSON.stringify(json) === JSON.stringify({ error: message });

function toCheck(id: string, requirement: string, outcome: Outcome): Check {
	return {
		id,
		requirement,
		ok: outcome.ok,
		detail: outcome.detail,
		...(outcome.skipped ? { skipped: true as const } : {})
	};
}

async function attempt(fn: () => Promise<Outcome>): Promise<Outcome> {
	try {
		return await fn();
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}

async function request(
	doFetch: typeof fetch,
	base: URL,
	path: string,
	init: RunInit
): Promise<Probe> {
	const response = await doFetch(new URL(path, base), {
		method: init.method ?? 'GET',
		headers: init.headers,
		body: init.body,
		redirect: 'manual',
		signal: AbortSignal.timeout(TIMEOUT_MS)
	});
	const text = await response.text();
	return { status: response.status, headers: response.headers, text, json: parseJson(text) };
}

type Route = { pattern?: unknown; scope?: unknown; strategy?: unknown };

/** the first route of a scope whose pattern names one path, not a parameter or a wildcard */
function concretePath(routes: readonly Route[], scope: string): string | undefined {
	const hit = routes.find(
		(route) =>
			route.scope === scope &&
			route.strategy !== 'static' &&
			typeof route.pattern === 'string' &&
			!/[:*]/.test(route.pattern)
	);
	return hit?.pattern as string | undefined;
}

/** reads the route table from `/spool-sw.js`, which carries the config as its first line */
async function discover(run: Run): Promise<{ public?: string; principal?: string }> {
	const probe = await run('/spool-sw.js');
	const prefix = 'self.__SPOOL_CONFIG__=';
	const end = probe.text.indexOf('\n');
	if (probe.status !== 200 || !probe.text.startsWith(prefix) || end < 0) return {};
	const config = parseJson(probe.text.slice(prefix.length, end).replace(/;$/, '')) as
		{ routes?: unknown } | undefined;
	const routes = (config?.routes ?? []) as Route[];
	return { public: concretePath(routes, 'public'), principal: concretePath(routes, 'principal') };
}

/** runs every check against `options.base` and returns each result in order */
export async function runConformance(options: ConformanceOptions): Promise<ConformanceResult> {
	const doFetch = options.fetch ?? fetch;
	const base = new URL(options.base);
	const run: Run = (path, init = {}) => request(doFetch, base, path, init);
	const checks: Check[] = [];
	const record = async (id: string, requirement: string, fn: () => Promise<Outcome>) => {
		checks.push(toCheck(id, requirement, await attempt(fn)));
	};
	const note = (id: string, requirement: string, outcome: Outcome) => {
		checks.push(toCheck(id, requirement, outcome));
	};
	const bodies: Array<{ label: string; body: unknown }> = [];
	const answers: Array<{ label: string; probe: Probe }> = [];
	const headers: Array<{ label: string; probe: Probe }> = [];
	const paths = await discover(run).catch(() => ({}) as { public?: string; principal?: string });

	await record(
		'sync-from',
		'GET /.spool/sync?from=<n> answers a SyncResponse with the server cursor',
		async () => {
			const probe = await run('/.spool/sync?from=0');
			if (probe.status !== 200) return fail(`status ${probe.status}, want 200`);
			bodies.push({ label: 'sync-from', body: probe.json });
			answers.push({ label: 'sync-from', probe });
			headers.push({ label: 'sync-from', probe });
			const sync = parseSyncResponse(withProtocol(probe.json));
			return pass(`cursor ${sync.cursor}, ${Object.keys(sync.changed).length} tags changed`);
		}
	);

	await record(
		'sync-need',
		'GET /.spool/sync?need= answers the cursor alone with partial true; a malformed need answers 400',
		async () => {
			const empty = await run('/.spool/sync?need=');
			if (empty.status !== 200) return fail(`need= status ${empty.status}, want 200`);
			bodies.push({ label: 'sync-need', body: empty.json });
			answers.push({ label: 'sync-need', probe: empty });
			const sync = parseSyncResponse(withProtocol(empty.json));
			if (!sync.partial) return fail('need= answer lacks partial: true');
			const bad = await run('/.spool/sync?need=x');
			answers.push({ label: 'sync-need-bad', probe: bad });
			if (bad.status !== 400) return fail(`need=x status ${bad.status}, want 400`);
			return pass(`cursor ${sync.cursor}, partial true; need=x answers 400`);
		}
	);

	await record(
		'artifact-have',
		'GET /.spool/artifact?path= answers the Artifact for a path; a bad have or path answers 400',
		async () => {
			const path = paths.public;
			if (path === undefined) return skip('no public route named by /spool-sw.js');
			const encoded = encodeURIComponent(path);
			const probe = await run(
				`/.spool/artifact?path=${encoded}&have=${encodeURIComponent('spool-conformance@0')}`
			);
			if (probe.status !== 200) return fail(`status ${probe.status}, want 200`);
			bodies.push({ label: 'artifact', body: probe.json });
			answers.push({ label: 'artifact', probe });
			headers.push({ label: 'artifact', probe });
			const artifact = parseArtifact(withProtocol(probe.json));
			if (artifact.id !== path) return fail(`id ${artifact.id}, want ${path}`);
			const badHave = await run(`/.spool/artifact?path=${encoded}&have=x`);
			answers.push({ label: 'artifact-bad-have', probe: badHave });
			if (badHave.status !== 400) return fail(`have=x status ${badHave.status}, want 400`);
			const badPath = await run('/.spool/artifact?path=x');
			answers.push({ label: 'artifact-bad-path', probe: badPath });
			if (badPath.status !== 400) return fail(`path=x status ${badPath.status}, want 400`);
			return pass(`${path} at cursor ${artifact.vector}; bad have and path answer 400`);
		}
	);

	await record(
		'beacon',
		'A batch with no events answers 204; a batch with want answers 200 with artifacts',
		async () => {
			const post = (batch: object) =>
				run('/.spool/beacon', {
					method: 'POST',
					body: JSON.stringify({ protocol: PROTOCOL_VERSION, events: [], ...batch }),
					headers: { 'content-type': 'application/json' }
				});
			const empty = await post({});
			if (empty.status !== 204) return fail(`empty batch status ${empty.status}, want 204`);
			const path = paths.public;
			if (path === undefined)
				return pass('empty batch answers 204; want not run, no public route');
			const want = await post({ want: [path] });
			if (want.status !== 200) return fail(`want status ${want.status}, want 200`);
			bodies.push({ label: 'beacon-want', body: want.json });
			answers.push({ label: 'beacon-want', probe: want });
			const list = (want.json as { artifacts?: unknown } | undefined)?.artifacts;
			if (!Array.isArray(list)) return fail('200 answer has no artifacts list');
			return pass(`empty batch 204; want ${path} answered ${list.length} artifact(s)`);
		}
	);

	await record(
		'not-found',
		'An unknown path or an unlisted method under /.spool/ answers 404 {"error":"not found"}',
		async () => {
			const unknown = await run('/.spool/nope');
			const unlisted = await run('/.spool/sync', { method: 'POST' });
			answers.push(
				{ label: 'not-found', probe: unknown },
				{ label: 'not-found-post', probe: unlisted }
			);
			for (const [label, probe] of [
				['GET /.spool/nope', unknown],
				['POST /.spool/sync', unlisted]
			] as const) {
				if (probe.status !== 404) return fail(`${label} status ${probe.status}, want 404`);
				if (!errorIs(probe.json, 'not found'))
					return fail(`${label} body is not not-found`);
			}
			return pass('GET /.spool/nope and POST /.spool/sync answer 404 not found');
		}
	);

	await record('beacon-method', 'GET /.spool/beacon answers 405 with Allow: POST', async () => {
		const probe = await run('/.spool/beacon');
		if (probe.status !== 405) return fail(`status ${probe.status}, want 405`);
		const allow = probe.headers.get('allow');
		if (allow !== 'POST') return fail(`allow ${allow}, want POST`);
		return pass('GET answers 405 with Allow: POST');
	});

	await record('error-400', 'A ProtocolError answers 400 with its message', async () => {
		const probe = await run('/.spool/sync?from=x');
		answers.push({ label: 'error-400', probe });
		if (probe.status !== 400) return fail(`status ${probe.status}, want 400`);
		const error = (probe.json as { error?: unknown } | undefined)?.error;
		if (typeof error !== 'string' || error === '') return fail('400 body has no error message');
		return pass(`400 with "${error}"`);
	});

	// no request the kit can send makes a healthy server fail internally, so this never runs
	note(
		'error-500',
		'Any other exception answers 500 {"error":"internal error"} with no detail',
		skip('no request the kit can send provokes an internal error; see the results file')
	);

	const names = options.datasets ?? [];
	if (names.length === 0) {
		for (const id of [
			'dataset-seed',
			'dataset-proof',
			'dataset-changes',
			'dataset-tombstone'
		]) {
			note(id, 'dataset check', skip('no --dataset given'));
		}
	}
	for (const name of names) {
		await datasetChecks(name);
	}

	async function readSeed(name: string): Promise<Seed | typeof DECLINED> {
		const rows = new Map<string, Plain>();
		let after: string | undefined;
		let first: DatasetResponse | undefined;
		let last: DatasetResponse | undefined;
		let previous: string | undefined;
		let pages = 0;
		do {
			pages += 1;
			if (pages > MAX_PAGES) throw new Error(`more than ${MAX_PAGES} seed pages`);
			const params = new URLSearchParams(after === undefined ? { name } : { name, after });
			const probe = await run(`/.spool/dataset?${params}`);
			answers.push({ label: `dataset:${name}`, probe });
			if (probe.status === 409 && first === undefined) {
				const error = (probe.json as { error?: unknown } | undefined)?.error;
				if (error === DECLINED) return DECLINED;
			}
			if (probe.status !== 200) throw new Error(`seed page ${pages} status ${probe.status}`);
			bodies.push({ label: `dataset:${name}`, body: probe.json });
			const page = parseDatasetResponse(withProtocol(probe.json));
			if (page.name !== name) throw new Error(`page names dataset ${page.name}`);
			if (!page.reset) throw new Error(`seed page ${pages} is not a reset`);
			if (page.deletes.length > 0) throw new Error(`seed page ${pages} carries deletes`);
			if (page.after !== after)
				throw new Error(`page echoes after ${page.after}, sent ${after}`);
			for (const { key, row } of page.puts) {
				if (previous !== undefined && key <= previous) {
					throw new Error(`key ${key} is not after ${previous}`);
				}
				previous = key;
				rows.set(key, row);
			}
			first ??= page;
			last = page;
			after = page.next;
		} while (after !== undefined);
		const proof = last?.proof;
		if (first === undefined || proof === undefined) {
			throw new Error('the last seed page has no proof');
		}
		const computed = await setProof(rows);
		return {
			rows,
			cursor: first.cursor,
			schema: first.schema,
			proof,
			computed,
			pages
		};
	}

	async function datasetChecks(name: string) {
		const label = (id: string) => `${id}:${name}`;
		let seed: Seed | typeof DECLINED | undefined;
		let patch: DatasetResponse | 'reseed' | undefined;
		await record(
			label('dataset-seed'),
			'A seed is every row in ascending key order, in pages, and the last page carries a proof',
			async () => {
				const result = await readSeed(name);
				if (result === DECLINED) return skip('seed declined by admission (provision auto)');
				seed = result;
				return pass(
					`${result.computed.count} rows in ${result.pages} page(s) at cursor ${result.cursor}`
				);
			}
		);
		await record(
			label('dataset-proof'),
			'The proof on the last seed page is the set digest of the rows',
			async () => {
				if (seed === undefined || seed === DECLINED) return skip('no seed read');
				const { proof, computed } = seed;
				if (proof.count !== computed.count || proof.digest !== computed.digest) {
					return fail(
						`proof says ${proof.count} rows and ${proof.digest.slice(0, 12)}; the rows give ${computed.count} and ${computed.digest.slice(0, 12)}`
					);
				}
				return pass(`${computed.count} rows match the proof`);
			}
		);
		await record(
			label('dataset-changes'),
			'A patch since the seed cursor is a later cursor with reset false and a proof',
			async () => {
				if (seed === undefined || seed === DECLINED) return skip('no seed read');
				const params = new URLSearchParams({
					name,
					since: String(seed.cursor),
					schema: seed.schema
				});
				const probe = await run(`/.spool/dataset?${params}`);
				answers.push({ label: `patch:${name}`, probe });
				if (probe.status !== 200) return fail(`patch status ${probe.status}, want 200`);
				bodies.push({ label: `patch:${name}`, body: probe.json });
				const response = parseDatasetResponse(withProtocol(probe.json));
				if (response.name !== name || response.schema !== seed.schema) {
					return fail('patch names another dataset or schema');
				}
				if (response.reset) {
					patch = 'reseed';
					return skip('server reseeds at the seed cursor (horizon above it)');
				}
				if (response.cursor < seed.cursor) {
					return fail(`cursor ${response.cursor} is below ${seed.cursor}`);
				}
				patch = response;
				return pass(
					`${seed.cursor} to ${response.cursor}: ${response.puts.length} puts, ${response.deletes.length} deletes`
				);
			}
		);
		await record(
			label('dataset-tombstone'),
			'A delete arrives as a tombstone; applying the patch to the seed gives the proof it sends',
			async () => {
				if (seed === undefined || seed === DECLINED) return skip('no seed read');
				if (patch === undefined) return skip('no patch read');
				if (patch === 'reseed') return skip('server reseeds at the seed cursor');
				const applied = await applyChanges(seed.rows, patch, seed.computed.digest);
				if (applied.matches !== true) {
					return fail(
						`${patch.deletes.length} deletes and ${patch.puts.length} puts give ${applied.rows.size} rows; the proof says ${patch.proof?.count}`
					);
				}
				return pass(`${patch.deletes.length} deletes applied; rows match the proof`);
			}
		);
	}

	await record(
		'principal-no-store',
		'A principal artifact answers Cache-Control private, no-store',
		async () => {
			if (options.principal === undefined) return skip('no --header given');
			const path = paths.principal;
			if (path === undefined) return skip('no principal route named by /spool-sw.js');
			const probe = await run(`/.spool/artifact?path=${encodeURIComponent(path)}`, {
				headers: options.principal
			});
			if (probe.status !== 200)
				return fail(`status ${probe.status}, want 200 with the principal`);
			bodies.push({ label: 'principal-artifact', body: probe.json });
			const cache = probe.headers.get('cache-control');
			if (cache !== 'private, no-store') return fail(`cache-control ${cache}`);
			return pass(`${path} answers private, no-store`);
		}
	);

	const protocolRequirement = 'Every JSON body carries protocol, an integer 1';
	if (bodies.length === 0) {
		note('protocol-integer', protocolRequirement, skip('no JSON body collected'));
	} else {
		const wrong = bodies
			.filter(({ body }) => (body as { protocol?: unknown } | undefined)?.protocol !== 1)
			.map(({ label }) => label);
		note(
			'protocol-integer',
			protocolRequirement,
			wrong.length > 0
				? fail(`protocol is not 1 in: ${wrong.join(', ')}`)
				: pass(`${bodies.length} bodies carry protocol 1`)
		);
	}

	const grammarRequirement =
		'Spool headers hold integers matching ^\\d{1,15}$; Spool-Protocol is 1';
	if (headers.length === 0) {
		note('header-grammar', grammarRequirement, skip('no spool response collected'));
	} else {
		const bad = headers.flatMap(({ label, probe }) => {
			const issues: string[] = [];
			if (probe.headers.get(HEADERS.protocol) !== '1') issues.push(`${label} spool-protocol`);
			const vector = probe.headers.get(HEADERS.vector);
			if (vector !== null && !INTEGER.test(vector)) issues.push(`${label} spool-vector`);
			if (label === 'sync-from' && vector === null) issues.push(`${label} spool-vector`);
			return issues;
		});
		note(
			'header-grammar',
			grammarRequirement,
			bad.length > 0
				? fail(`bad: ${bad.join(', ')}`)
				: pass(`${headers.length} responses checked`)
		);
	}

	if (answers.length === 0) {
		note('json-type', 'Every JSON answer is Content-Type application/json', skip('no answers'));
		note('no-store', 'Every JSON answer is Cache-Control no-store', skip('no answers'));
	} else {
		const notJson = answers.filter(({ probe }) => !isJson(probe)).map(({ label }) => label);
		note(
			'json-type',
			'Every JSON answer is Content-Type application/json',
			notJson.length > 0
				? fail(`not JSON: ${notJson.join(', ')}`)
				: pass(`${answers.length} answers`)
		);
		const noStore = answers
			.filter(({ probe }) => probe.headers.get('cache-control') !== 'no-store')
			.map(({ label }) => label);
		note(
			'no-store',
			'Every JSON answer is Cache-Control no-store',
			noStore.length > 0
				? fail(`not no-store: ${noStore.join(', ')}`)
				: pass(`${answers.length} answers`)
		);
	}

	return { checks, ok: checks.every((check) => check.ok || check.skipped) };
}

type CliArgs = { url: string; datasets: string[]; headers: string[] };

function parseArgs(argv: readonly string[]): CliArgs | undefined {
	const out: CliArgs = { url: '', datasets: [], headers: [] };
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (value === undefined) return undefined;
		if (flag === '--url') out.url = value;
		else if (flag === '--dataset') out.datasets.push(value);
		else if (flag === '--header') out.headers.push(value);
		else return undefined;
	}
	return out.url === '' ? undefined : out;
}

function headerRecord(lines: readonly string[]): Record<string, string> | undefined {
	if (lines.length === 0) return undefined;
	const out: Record<string, string> = {};
	for (const line of lines) {
		const at = line.indexOf(':');
		if (at < 1) throw new Error(`--header needs "Name: value", got "${line}"`);
		out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
	}
	return out;
}

/** the CLI: one line per check, exit 1 when any check fails */
export async function main(argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv);
	if (args === undefined) {
		console.error(
			'usage: bun scripts/conformance.ts --url <origin> [--dataset <name>] [--header "Name: value"]'
		);
		return 2;
	}
	const result = await runConformance({
		base: args.url,
		datasets: args.datasets,
		principal: headerRecord(args.headers)
	});
	for (const check of result.checks) {
		const status = check.skipped ? 'skip' : check.ok ? 'ok  ' : 'FAIL';
		console.log(`${status} ${check.id} ${check.detail}`);
	}
	const failed = result.checks.filter((check) => !check.ok && !check.skipped).length;
	const skipped = result.checks.filter((check) => check.skipped).length;
	console.log(
		`${result.checks.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`
	);
	return result.ok ? 0 : 1;
}

if (isMain(import.meta.url)) {
	process.exitCode = await main(process.argv.slice(2));
}
