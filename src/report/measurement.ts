import type { Layer } from './inputs.js';

/** the rigs that write to `measurements/<rig>/`, one folder each */
export const RIGS = [
	'repeat-nav',
	'on-wire',
	'zero-network',
	'device-cpu',
	'rapl',
	'iphone',
	'payload',
	'trim',
	'link-assets',
	'image-crawl',
	'dictionary-size'
] as const;

/** one of {@link RIGS} */
export type Rig = (typeof RIGS)[number];

/** the format version {@link parseMeasurement} reads */
export const MEASUREMENT_SCHEMA = 1;

/** one window or navigation as the rig recorded it: raw quantities, never a per-view figure */
export type Row = Record<string, unknown>;

/** one run of one rig, as stored in `measurements/<rig>/<date>[-<experiment>].json` */
export type Measurement = {
	schema: typeof MEASUREMENT_SCHEMA;
	rig: Rig;
	/** the run date, UTC, `YYYY-MM-DD` */
	date: string;
	layer: Extract<Layer, 'L1'>;
	/** what the run answers */
	question: string;
	/** what read the numbers */
	instrument: string;
	/** the hardware, with at least a `name` */
	machine: Record<string, string | number>;
	software: Record<string, string>;
	/** windows, rounds, arm order, pacing and any emulation */
	method: Record<string, unknown>;
	/** rules for rows a reader must drop, with the reason */
	exclusions: string[];
	rows: Row[];
};

/** every problem a file has, so one read reports them all */
export class MeasurementError extends Error {
	readonly problems: string[];

	constructor(problems: string[], source?: string) {
		super(`${source ? `${source}: ` : ''}${problems.join('; ')}`);
		this.name = 'MeasurementError';
		this.problems = problems;
	}
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string =>
	typeof value === 'string' && value.trim() !== '';

/** a device id, a container id used as a key, or an address that is not loopback */
const LEAKS: Array<[string, RegExp]> = [
	['a device id', /\b0000[0-9A-F]{4}-[0-9A-F]{16}\b/],
	['a container id', /"[0-9a-f]{12}":/],
	['an IP address', /\b(?!127\.0\.0\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/]
];

/** what a published file must not carry: the kinds of id or address found in `text` */
export function findLeaks(text: string): string[] {
	return LEAKS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function validDate(text: string): boolean {
	if (!DATE.test(text)) return false;
	const date = new Date(`${text}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

/** the problems with one measurement document, empty when it is valid */
export function measurementProblems(input: unknown): string[] {
	if (!isRecord(input)) return ['the file is not a JSON object'];
	const problems: string[] = [];
	if (input.schema !== MEASUREMENT_SCHEMA) problems.push(`schema must be ${MEASUREMENT_SCHEMA}`);
	if (!RIGS.includes(input.rig as Rig)) problems.push(`rig must be one of ${RIGS.join(', ')}`);
	if (typeof input.date !== 'string' || !validDate(input.date)) {
		problems.push('date must be a real UTC date as YYYY-MM-DD');
	}
	if (input.layer !== 'L1') problems.push('layer must be L1, readings here are measured');
	for (const key of ['question', 'instrument'] as const) {
		if (!isText(input[key])) problems.push(`${key} must be a non-empty string`);
	}
	const { machine, software } = input;
	if (!isRecord(machine) || !isText(machine.name)) problems.push('machine needs a name');
	else if (!Object.values(machine).every((v) => typeof v === 'string' || typeof v === 'number')) {
		problems.push('machine values must be strings or numbers');
	}
	if (!isRecord(software) || !Object.values(software).every((v) => typeof v === 'string')) {
		problems.push('software must map names to version strings');
	}
	if (!isRecord(input.method)) problems.push('method must be an object');
	const { exclusions } = input;
	if (!Array.isArray(exclusions) || !exclusions.every(isText)) {
		problems.push('exclusions must be a list of reasons');
	}
	const { rows } = input;
	if (!Array.isArray(rows) || rows.length === 0 || !rows.every(isRecord)) {
		problems.push('rows must be a non-empty list of objects');
	}
	return problems;
}

/** the document as a {@link Measurement}, or a {@link MeasurementError} naming every problem */
export function parseMeasurement(input: unknown, source?: string): Measurement {
	const problems = measurementProblems(input);
	if (problems.length > 0) throw new MeasurementError(problems, source);
	return input as Measurement;
}

/** {@link parseMeasurement} over JSON text, which also refuses ids and addresses a file must not carry */
export function parseMeasurementText(text: string, source?: string): Measurement {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new MeasurementError([`invalid JSON (${(error as Error).message})`], source);
	}
	const leaks = findLeaks(text).map((name) => `contains ${name}`);
	if (leaks.length > 0) throw new MeasurementError(leaks, source);
	return parseMeasurement(parsed, source);
}

/** where a run is stored, relative to `measurements/`: `<rig>/<date>[-<experiment>].json` */
export function measurementPath(
	measurement: Pick<Measurement, 'rig' | 'date'>,
	experiment?: string
): string {
	return `${measurement.rig}/${measurement.date}${experiment ? `-${experiment}` : ''}.json`;
}

/** whether a path under `measurements/` matches the rig and date inside the file */
export function pathMatches(path: string, measurement: Pick<Measurement, 'rig' | 'date'>): boolean {
	const expected = `${measurement.rig}/${measurement.date}`;
	return (
		path === `${expected}.json` || (path.startsWith(`${expected}-`) && path.endsWith('.json'))
	);
}

/** the file text a rig writes: tab indented, one trailing newline, `schema` first */
export function serialiseMeasurement(measurement: Omit<Measurement, 'schema'>): string {
	return `${JSON.stringify({ schema: MEASUREMENT_SCHEMA, ...measurement }, null, '\t')}\n`;
}
