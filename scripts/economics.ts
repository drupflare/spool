import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import {
	AZURE_EGRESS,
	BOOTSTRAP_EXTRA_NO_WORKER,
	BOOTSTRAP_EXTRA_WORKER,
	CF_FREE_REQUESTS_PER_DAY,
	CF_PAID_INCLUDED,
	CF_PAID_PER_MILLION,
	DOCUMENT_BYTES,
	ECON_PRICES_READ,
	GCP_EGRESS,
	WEBKIT_STUB_RATE,
	WORKLOADS,
	baselinePerReadView,
	egressUsd,
	firstViewDocumentMedian,
	freeReadViewsPerDay,
	heldShare,
	noWorkerRequestsPerReadView,
	overIncluded,
	paidRequestsUsd,
	requestsPerReadView,
	webkitStubPerReadView,
	type Workload
} from '../src/report/index';
import { HEADLINE_TABLES, HEADLINE_VALUES, buildHeadlineFigures, pickFigures } from './headline';
import {
	ROOT,
	fixed,
	loadReadings,
	pinned,
	render,
	table,
	type Figures,
	type Readings
} from './impact';
import { isMain } from './measure/lib';

export const FIRST_VIEW_READING = 'rapl/2026-11-16-first-view.json';

/** monthly read views the outputs project */
export const VOLUMES = [1e6, 1e7, 1e8] as const;

const usd = (n: number): string => `$${fixed(n, 2)}`;
const pct = (z: number): string => `${fixed(z * 100, 1)}%`;

/** the numbers the economics page prints, computed from the readings and `src/report` */
export function buildEconomics(readings: Readings): Figures {
	const v: Record<string, string> = {};
	const t: Record<string, string> = {};
	const doc = DOCUMENT_BYTES.value;
	const firstReading = pinned(readings, FIRST_VIEW_READING);
	const firstDoc = firstViewDocumentMedian(firstReading);
	const pages = (firstReading.method['corpus pages'] as unknown[]).length;
	const rows = WORKLOADS.map((w: Workload) => {
		const requests = requestsPerReadView(w);
		const base = baselinePerReadView(w);
		return {
			w,
			requests,
			noWorker: noWorkerRequestsPerReadView(w),
			webkit: webkitStubPerReadView(w),
			base,
			held: heldShare(w, requests),
			multiplier: base / requests
		};
	});

	v.repeatDocument = fixed(doc);
	v.firstDocument = fixed(firstDoc);
	v.firstPages = fixed(pages);
	v.bootstrapWorker = fixed(BOOTSTRAP_EXTRA_WORKER.value);
	v.bootstrapNoWorker = fixed(BOOTSTRAP_EXTRA_NO_WORKER.value);
	v.webkitRate = fixed(WEBKIT_STUB_RATE.value);
	v.freeLimit = fixed(CF_FREE_REQUESTS_PER_DAY.value);
	v.paidIncluded = fixed(CF_PAID_INCLUDED.value);
	v.paidPrice = usd(CF_PAID_PER_MILLION.value);
	v.pricesRead = ECON_PRICES_READ;

	t.inputs = table(
		['input', 'value', 'unit', 'layer', 'source'],
		[
			[
				'Repeat-view document, median',
				fixed(doc),
				'B',
				DOCUMENT_BYTES.layer,
				DOCUMENT_BYTES.source
			],
			[
				'First-view document, median over the corpus pages',
				fixed(firstDoc),
				'B',
				'L1',
				`measurements/${FIRST_VIEW_READING}: classBytes.document over ${pages} pages`
			],
			[
				'Bootstrap requests after the first document, with a worker (k)',
				fixed(BOOTSTRAP_EXTRA_WORKER.value),
				'requests',
				BOOTSTRAP_EXTRA_WORKER.layer,
				BOOTSTRAP_EXTRA_WORKER.source
			],
			[
				'Bootstrap requests after the first document, without a worker (k)',
				fixed(BOOTSTRAP_EXTRA_NO_WORKER.value),
				'requests',
				BOOTSTRAP_EXTRA_NO_WORKER.layer,
				BOOTSTRAP_EXTRA_NO_WORKER.source
			],
			[
				'WebKit macOS script check per document navigation',
				fixed(WEBKIT_STUB_RATE.value),
				'requests',
				WEBKIT_STUB_RATE.layer,
				WEBKIT_STUB_RATE.source
			],
			...WORKLOADS.map((w) => [
				`WebKit macOS navigations per lifetime (e): ${w.name}`,
				fixed(w.webkitNavigations.value),
				w.webkitNavigations.unit,
				w.webkitNavigations.layer,
				w.webkitNavigations.source
			]),
			[
				'Free plan Worker requests',
				fixed(CF_FREE_REQUESTS_PER_DAY.value),
				CF_FREE_REQUESTS_PER_DAY.unit,
				CF_FREE_REQUESTS_PER_DAY.layer,
				CF_FREE_REQUESTS_PER_DAY.source
			],
			[
				'Paid plan included requests',
				fixed(CF_PAID_INCLUDED.value),
				CF_PAID_INCLUDED.unit,
				CF_PAID_INCLUDED.layer,
				CF_PAID_INCLUDED.source
			],
			[
				'Paid plan price per additional million',
				usd(CF_PAID_PER_MILLION.value),
				CF_PAID_PER_MILLION.unit,
				CF_PAID_PER_MILLION.layer,
				CF_PAID_PER_MILLION.source
			],
			[
				'Azure internet egress, next 10 TB a month',
				`$${fixed(AZURE_EGRESS.egress.value, 3)}`,
				AZURE_EGRESS.egress.unit,
				AZURE_EGRESS.egress.layer,
				AZURE_EGRESS.egress.source
			],
			[
				'Azure free allowance',
				fixed(AZURE_EGRESS.freeAllowance?.value ?? 0),
				AZURE_EGRESS.freeAllowance?.unit ?? '',
				AZURE_EGRESS.freeAllowance?.layer ?? '',
				AZURE_EGRESS.freeAllowance?.source ?? ''
			],
			[
				'Google Cloud egress, 1 GiB to 1,024 GiB a month',
				usd(GCP_EGRESS.egress.value),
				GCP_EGRESS.egress.unit,
				GCP_EGRESS.egress.layer,
				GCP_EGRESS.egress.source
			],
			[
				'Google Cloud free allowance',
				fixed(GCP_EGRESS.freeAllowance?.value ?? 0),
				GCP_EGRESS.freeAllowance?.unit ?? '',
				GCP_EGRESS.freeAllowance?.layer ?? '',
				GCP_EGRESS.freeAllowance?.source ?? ''
			]
		],
		[1]
	);

	t.workloads = table(
		[
			'workload',
			'views per lifetime (v)',
			'lifetimes per bootstrap (L)',
			'syncs per lifetime (s)',
			'updates per lifetime (u)',
			'writes per read view (w)',
			'contacts per read view (f)',
			'WebKit macOS navigations per lifetime (e)',
			'Chromium, Firefox and Linux WebKit: requests per read view, spool, with a worker (L2)',
			'requests per read view, spool, without a worker (L2)',
			'WebKit macOS script checks per read view (L2)',
			'WebKit macOS: requests per read view, spool, with a worker (L2)',
			'requests per read view, no spool (L2)',
			'held share (L2)',
			'multiplier (L2)'
		],
		rows.map(({ w, requests, noWorker, webkit, base, held, multiplier }) => [
			w.name,
			fixed(w.viewsPerLifetime),
			fixed(w.lifetimes),
			fixed(w.syncs, 1),
			fixed(w.updates, 1),
			fixed(w.writes, 2),
			fixed(w.contacts, 2),
			fixed(w.webkitNavigations.value),
			fixed(requests, 3),
			fixed(noWorker, 3),
			fixed(webkit, 3),
			fixed(requests + webkit, 3),
			fixed(base, 1),
			pct(held),
			fixed(multiplier, 2)
		]),
		[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
	);

	t.bandwidth = table(
		[
			'workload',
			'read views a month',
			'held share (L2)',
			'GB a month no longer sent (L2)',
			'Azure list price, before allowance (L2)',
			'Google Cloud list price, before allowance (L2)'
		],
		VOLUMES.flatMap((n) =>
			rows.map(({ w, held }) => {
				const local = n * held;
				return [
					w.name,
					fixed(n),
					pct(held),
					fixed((local * doc) / 1e9, 1),
					usd(egressUsd(local, AZURE_EGRESS, doc)),
					usd(egressUsd(local, GCP_EGRESS, doc))
				];
			})
		),
		[1, 2, 3, 4, 5]
	);

	t['free-plan'] = table(
		[
			'workload',
			'read views a day, no spool (L2)',
			'Chromium, Firefox and Linux WebKit: read views a day, spool, stub on the Worker (L2)',
			'Chromium, Firefox and Linux WebKit: read views a day, spool, stub on a static tier (L2)',
			'WebKit macOS: read views a day, spool, stub on the Worker (L2)',
			'WebKit macOS: read views a day, spool, stub on a static tier (L2)',
			'multiplier, stub on a static tier (L2)'
		],
		rows.map(({ w, requests, webkit, base, multiplier }) => [
			w.name,
			fixed(freeReadViewsPerDay(base)),
			fixed(freeReadViewsPerDay(requests)),
			fixed(freeReadViewsPerDay(requests)),
			fixed(freeReadViewsPerDay(requests + webkit)),
			fixed(freeReadViewsPerDay(requests)),
			fixed(multiplier, 2)
		]),
		[1, 2, 3, 4, 5, 6]
	);

	t['paid-plan-requests'] = table(
		[
			'workload',
			'read views a month',
			'Worker requests, no spool (L2)',
			'Chromium, Firefox and Linux WebKit: Worker requests, spool, stub on the Worker (L2)',
			'Chromium, Firefox and Linux WebKit: Worker requests, spool, stub on a static tier (L2)',
			'WebKit macOS: Worker requests, spool, stub on the Worker (L2)',
			'WebKit macOS: Worker requests, spool, stub on a static tier (L2)'
		],
		VOLUMES.flatMap((n) =>
			rows.map(({ w, requests, webkit, base }) => [
				w.name,
				fixed(n),
				fixed(n * base),
				fixed(n * requests),
				fixed(n * requests),
				fixed(n * (requests + webkit)),
				fixed(n * requests)
			])
		),
		[1, 2, 3, 4, 5, 6]
	);

	t['paid-plan-usd'] = table(
		[
			'workload',
			'read views a month',
			'above the included amount, no spool (L2)',
			'dollars, no spool (L2)',
			'Chromium, Firefox and Linux WebKit, stub on the Worker: above the included amount (L2)',
			'Chromium, Firefox and Linux WebKit, stub on the Worker: dollars (L2)',
			'Chromium, Firefox and Linux WebKit, stub on a static tier: above the included amount (L2)',
			'Chromium, Firefox and Linux WebKit, stub on a static tier: dollars (L2)',
			'WebKit macOS, stub on the Worker: above the included amount (L2)',
			'WebKit macOS, stub on the Worker: dollars (L2)',
			'WebKit macOS, stub on a static tier: above the included amount (L2)',
			'WebKit macOS, stub on a static tier: dollars (L2)'
		],
		VOLUMES.flatMap((n) =>
			rows.map(({ w, requests, webkit, base }) => {
				const none = n * base;
				const chromium = n * requests;
				const macos = n * (requests + webkit);
				return [
					w.name,
					fixed(n),
					fixed(overIncluded(none)),
					usd(paidRequestsUsd(none)),
					fixed(overIncluded(chromium)),
					usd(paidRequestsUsd(chromium)),
					fixed(overIncluded(chromium)),
					usd(paidRequestsUsd(chromium)),
					fixed(overIncluded(macos)),
					usd(paidRequestsUsd(macos)),
					fixed(overIncluded(chromium)),
					usd(paidRequestsUsd(chromium))
				];
			})
		),
		[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
	);

	const headline = buildHeadlineFigures(readings, { fixed, table, pinned });
	Object.assign(v, pickFigures(headline, HEADLINE_VALUES, []).values);
	Object.assign(t, pickFigures(headline, [], HEADLINE_TABLES).tables);

	return { values: v, tables: t };
}

/** the formatted `docs/economics.md` for the repository at `root` */
export async function buildEconomicsPage(root: string = ROOT): Promise<string> {
	const template = readFileSync(join(root, 'docs/economics.src.md'), 'utf8');
	const text = render(template, buildEconomics(loadReadings(root)));
	const config = (await resolveConfig(join(root, 'docs/economics.md'))) ?? {};
	return format(text, {
		...config,
		filepath: join(root, 'docs/economics.md'),
		parser: 'markdown'
	});
}

if (isMain(import.meta.url)) {
	const target = join(ROOT, 'docs/economics.md');
	const built = await buildEconomicsPage();
	if (process.argv.includes('--check')) {
		const current = readFileSync(target, 'utf8');
		if (current !== built) {
			console.error('docs/economics.md differs from the readings; run: bun run economics');
			process.exit(1);
		}
		console.log('docs/economics.md matches the readings');
	} else {
		writeFileSync(target, built);
		console.log('docs/economics.md written');
	}
}
