import { chromium } from '@playwright/test';
import { parseArgs } from 'node:util';
import {
	MEASUREMENTS_DIR,
	isMain,
	localMachine,
	utcDate,
	writeMeasurement,
	type Draft
} from './lib';
import { SITES, walkSite } from './repeat-nav';
import { createCa, startWireProxy, summarise } from './wire-proxy';

export function parse(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: {
			site: { type: 'string', multiple: true },
			links: { type: 'string', default: '6' },
			machine: { type: 'string' },
			out: { type: 'string', default: MEASUREMENTS_DIR },
			force: { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false }
		}
	});
	return {
		sites: values.site?.length ? values.site : SITES,
		links: Number(values.links),
		machine: values.machine,
		out: values.out as string,
		force: values.force as boolean,
		dryRun: values['dry-run'] as boolean
	};
}

if (isMain(import.meta.url)) {
	const args = parse(process.argv.slice(2));
	if (args.dryRun) {
		console.log(JSON.stringify({ rig: 'on-wire', date: utcDate(), ...args }, null, 2));
	} else {
		const ca = createCa();
		const proxy = await startWireProxy({ ca });
		const browser = await chromium.launch({ proxy: { server: proxy.url } });
		const rows: Array<Record<string, unknown>> = [];
		for (const site of args.sites) {
			const context = await browser.newContext({ ignoreHTTPSErrors: true });
			const host = new URL(site).host;
			let mark = proxy.mark();
			rows.push(
				await walkSite(context, site, {
					links: args.links,
					after: async () => {
						await proxy.idle();
						const wire = summarise(proxy.entries.slice(mark), host);
						mark = proxy.mark();
						return { wire };
					}
				})
			);
			await context.close();
			console.error(site);
		}
		const version = browser.version();
		await browser.close();
		await proxy.stop();
		const draft: Draft = {
			rig: 'on-wire',
			date: utcDate(),
			layer: 'L1',
			question:
				'requests and bytes that reach the origin, counted by a proxy, beside the requests and bytes the browser reports, on the repeat-navigation site list',
			instrument:
				'a counting HTTP proxy between Chromium and the origin (scripts/measure/wire-proxy.ts, a throwaway CA decrypts CONNECT tunnels); the browser side is Chrome DevTools Protocol Network events',
			machine: localMachine(args.machine),
			software: {
				browser: `Chromium ${version}, Playwright bundled build`,
				proxy: process.versions.bun
					? `Bun ${process.versions.bun}`
					: `Node ${process.version}`
			},
			method: {
				'views per site': 'cold home, up to 6 internal links, home repeat',
				sites: args.sites.length,
				network: 'the local network through the proxy, no emulation',
				'wire counts':
					'requests the proxy sent to origins, over the same navigations the browser counted; sizes are HTTP/1.1 text sizes (request line, headers, body)',
				'origin leg':
					'HTTP/1.1 only, Node TLS client; sites that vary by protocol or client can answer differently than they do to a direct browser'
			},
			exclusions: ['a navigation whose ok field is not true did not finish loading'],
			rows
		};
		console.log(writeMeasurement(args.out, draft, { overwrite: args.force }));
	}
}
