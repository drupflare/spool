import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as protocol from '../../src/protocol/index';
import { MAX_BEACON_BODY } from '../../src/server/beacon';
import { MAX_PIGGYBACK } from '../../src/server/spool';
import { FLUSH_CHUNK, MAX_HOLD_MS, VIEW_BATCH, VIEW_HOLD_MS } from '../../src/sw/analytics';
import { MAX_STATIC_BYTES } from '../../src/sw/static';

const root = fileURLToPath(new URL('../..', import.meta.url));
const pages = {
	'protocol.md': readFileSync(join(root, 'docs/protocol.md'), 'utf8'),
	'security.md': readFileSync(join(root, 'docs/security.md'), 'utf8')
};

/** the text under a `## title` heading, up to the next `## ` heading */
function section(text: string, title: string): string {
	const start = text.indexOf(`\n## ${title}\n`);
	expect(start, `## ${title}`).toBeGreaterThanOrEqual(0);
	const rest = text.slice(start + 1);
	const end = rest.indexOf('\n## ', 4);
	return end < 0 ? rest : rest.slice(0, end);
}

/** the second cell of the first table row whose first cell is `key` in code font */
function value(text: string, key: string): string | undefined {
	const cells = text
		.split('\n')
		.filter((line) => line.startsWith('|'))
		.map((line) =>
			line
				.split('|')
				.slice(1, -1)
				.map((cell) => cell.trim())
		)
		.find((row) => row[0] === `\`${key}\``);
	const cell = cells?.[1];
	return cell?.startsWith('`') ? cell.slice(1, -1) : cell?.replaceAll(',', '');
}

describe('docs/protocol.md', () => {
	const wire = pages['protocol.md'];

	it('lists every header with its current name', () => {
		const headers = section(wire, 'Headers');
		for (const [key, name] of Object.entries(protocol.HEADERS)) {
			expect(value(headers, key), `HEADERS.${key}`).toBe(name);
		}
	});

	it('lists every path with its current value', () => {
		const paths = section(wire, 'Paths');
		for (const [key, path] of Object.entries(protocol.PATHS)) {
			expect(value(paths, key), `PATHS.${key}`).toBe(path);
		}
	});

	it('lists every MAX_ constant of the protocol module with its current value', () => {
		const limits = Object.entries(protocol).filter(([name]) => name.startsWith('MAX_'));
		expect(limits.length).toBeGreaterThan(0);
		const table = section(wire, 'Limits');
		for (const [name, limit] of limits) {
			expect(value(table, name), name).toBe(String(limit));
		}
	});

	it('lists the other protocol constants with their current values', () => {
		const constants = {
			PROTOCOL_VERSION: protocol.PROTOCOL_VERSION,
			MANIFEST_SCHEMA: protocol.MANIFEST_SCHEMA,
			SPOOL_PREFIX: protocol.SPOOL_PREFIX,
			OWN_PREFIX: protocol.OWN_PREFIX,
			VIEW_PATH: protocol.VIEW_PATH,
			LOADS_PATH: protocol.LOADS_PATH,
			DROPPED_PATH: protocol.DROPPED_PATH,
			ARTIFACT_TAG_PREFIX: protocol.ARTIFACT_TAG_PREFIX,
			CLEAR_ALL: protocol.CLEAR_ALL,
			CLIENT_TAG_ATTR: protocol.CLIENT_TAG_ATTR,
			GA4_RECOMMENDED_MS: protocol.GA4_RECOMMENDED_MS,
			GA4_HARD_MS: protocol.GA4_HARD_MS
		};
		const table = section(wire, 'Limits');
		for (const [name, expected] of Object.entries(constants)) {
			expect(value(table, name), name).toBe(String(expected));
		}
	});

	it('lists the server and worker limits with their current values', () => {
		const limits = {
			MAX_PIGGYBACK,
			MAX_BEACON_BODY,
			MAX_STATIC_BYTES,
			MAX_HOLD_MS,
			VIEW_BATCH,
			VIEW_HOLD_MS,
			FLUSH_CHUNK
		};
		const table = section(wire, 'Limits');
		for (const [name, limit] of Object.entries(limits)) {
			expect(value(table, name), name).toBe(String(limit));
		}
	});

	it('lists the freshness defaults and the provisioning priors', () => {
		for (const [scope, freshness] of Object.entries(protocol.DEFAULT_FRESHNESS)) {
			const row = section(wire, 'Freshness')
				.split('\n')
				.find((line) => line.startsWith(`| \`${scope}\``));
			const cells = (row ?? '').split('|').map((cell) => cell.trim());
			expect(cells.slice(2, 4), scope).toEqual([
				`\`${freshness.maxStale}\``,
				`\`${freshness.mode}\``
			]);
		}
		const priors = section(wire, 'Provisioning');
		for (const [name, prior] of Object.entries(protocol.DEFAULT_PRIOR)) {
			expect(value(priors, name), name).toBe(String(prior));
		}
	});
});

describe('the links in docs/protocol.md and docs/security.md', () => {
	const slug = (heading: string) =>
		heading
			.toLowerCase()
			.replaceAll(/[^a-z0-9 -]/g, '')
			.replaceAll(' ', '-');
	const anchors = (text: string) =>
		[...text.matchAll(/^#{1,6} (.+)$/gm)].map((match) => slug(match[1] as string));

	it.each(Object.keys(pages) as Array<keyof typeof pages>)(
		'%s points only at headings that exist',
		(name) => {
			const text = pages[name];
			const links = [...text.matchAll(/\]\((?:(protocol|security)\.md)?#([a-z0-9-]+)\)/g)];
			expect(links.length).toBeGreaterThan(0);
			for (const [, file, anchor] of links) {
				const target = file ? (`${file}.md` as keyof typeof pages) : name;
				expect(anchors(pages[target]), `${target}#${anchor}`).toContain(anchor);
			}
		}
	);
});
