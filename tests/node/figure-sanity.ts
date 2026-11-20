import type { Figures } from '../../scripts/impact';

// a difference from an idle or replay baseline, a fit term or a net saving can fall below zero
const SIGNED =
	/saving|saved|differ|delta|residual|intercept|slope|coef|r2|ci$|\bci\b|\bvs\b|\bnet\b|netted|above|minus|range|min to max|per provisioned kb|^fit|^radio(request|script|difference)$/i;
// these tables print only figures above an idle baseline; their headers do not say so
const SIGNED_TABLES = new Set(['power-state', 'idle-activity-tabs', 'ledger-metered']);
// prose values quote differences inside sentences, so only finiteness is checked
const PROSE = /(text|sentence)$/i;
// a held share or hit ratio prints as a percentage, with or without the sign
const RATIO = /share|\bh(_|\b)/i;
const MULTIPLIER = /multiplier/i;
// a sign counts only at the start of a token, so the dashes in a date are not minus signs
const NUMBER = /(?:^|[\s(|])([+-]?)\$?(\d[\d,]*(?:\.\d+)?)(%?)/g;
const NON_FINITE = /\b(?:NaN|Infinity|undefined)\b/;

type Kind = 'signed' | 'prose' | 'ratio' | 'multiplier' | 'count';

function kindOf(label: string): Kind {
	if (SIGNED.test(label)) return 'signed';
	if (MULTIPLIER.test(label)) return 'multiplier';
	if (RATIO.test(label)) return 'ratio';
	return 'count';
}

function faults(kind: Kind, where: string, text: string): string[] {
	const found = NON_FINITE.test(text) ? [`${where}: ${text}`] : [];
	if (kind === 'signed' || kind === 'prose') return found;
	for (const [, sign, digits, percent] of text.matchAll(NUMBER)) {
		const scale = kind === 'ratio' || percent ? 100 : 1;
		const value = Number(`${sign}${digits!.replace(/,/g, '')}`) / scale;
		const bad =
			(kind === 'count' && value < 0) ||
			(kind === 'ratio' && value > 1) ||
			(kind === 'multiplier' && value <= 0);
		if (bad) found.push(`${where}: ${value} in "${text}"`);
	}
	return found;
}

const cells = (line: string): string[] =>
	line
		.trim()
		.slice(1, -1)
		.split('|')
		.map((cell) => cell.trim());

/** every printed value and table cell that is not finite, or is out of range for what it counts */
export function figureFaults({ values, tables }: Figures): string[] {
	const found = Object.entries(values).flatMap(([name, text]) =>
		faults(PROSE.test(name) ? 'prose' : kindOf(name), name, text)
	);
	for (const [name, text] of Object.entries(tables)) {
		const [head, , ...rows] = text.split('\n');
		const labels = cells(head ?? '');
		for (const row of rows) {
			cells(row).forEach((cell, i) => {
				const label = labels[i] ?? '';
				const kind = SIGNED_TABLES.has(name) ? 'signed' : kindOf(label);
				found.push(...faults(kind, `${name} / ${label}`, cell));
			});
		}
	}
	return found;
}
