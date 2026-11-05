import { PATHS } from '../protocol/config.js';
import {
	encodeDatasetRequest,
	parseDatasetResponse,
	type DatasetRequest,
	type DatasetResponse
} from '../protocol/dataset.js';
import { ProtocolError } from '../protocol/errors.js';
import type { DatasetStore, Staging } from './dataset.js';

/** why a dataset was not held or not brought current */
export type DatasetRefusal =
	/** the rows would use more than the storage the device has to give */
	| 'budget'
	/** the proof failed again after a patch and one reseed */
	| 'proof'
	/** the server has no such dataset, or refused the request */
	| 'unavailable'
	/** the server's answer was not a dataset response, or its paging did not advance */
	| 'bad-response'
	/** the replica was wiped while the apply ran */
	| 'epoch'
	/** the storage transaction failed, for example on quota */
	| 'storage';

/**
 * What one sync of one dataset ended as. `seeded` and `reseeded` replaced the rows, `patched`
 * changed them, `current` found nothing to change. `offline` means no answer came and the held
 * rows, if any, are as they were; `refused` names why a dataset is not held.
 */
export type DatasetOutcome = { name: string; requests: number } & (
	| { status: 'seeded' | 'reseeded' | 'patched' | 'current'; cursor: number; rows: number }
	| { status: 'offline' }
	| { status: 'refused'; reason: DatasetRefusal }
);

/** what a sync needs from the worker around it */
export type DatasetSyncDeps = {
	store: DatasetStore;
	fetch(url: string, init?: RequestInit): Promise<Response>;
	origin: string;
	/** the replica's wipe count */
	epoch(): number;
	/** the most bytes of rows one dataset may use; undefined when the device cannot tell */
	budget(): Promise<number | undefined>;
};

/** seed pages followed before a sync gives up on a server whose paging does not end */
export const DATASET_MAX_PAGES = 1000;

class Refused extends Error {
	constructor(readonly reason: DatasetRefusal) {
		super(reason);
	}
}

/**
 * Brings dataset `name` current. A held dataset asks for the changes since its cursor; one that
 * is not held, or that the server resets (past its horizon, another schema), seeds in pages. The
 * rows are applied to a staging area and written in one transaction after the collection proof
 * matches. A proof that fails after a seed is repaired by one patch from the first page's cursor,
 * which covers rows that moved while the pages were read; a proof that still fails clears the
 * dataset and reseeds once, and a second failure leaves it not held. Never throws: every end is
 * an outcome.
 */
export async function syncDataset(deps: DatasetSyncDeps, name: string): Promise<DatasetOutcome> {
	const { store, origin } = deps;
	const epoch = deps.epoch();
	let requests = 0;

	const get = async (request: DatasetRequest): Promise<DatasetResponse> => {
		requests += 1;
		const response = await deps.fetch(
			`${origin}${PATHS.dataset}?${encodeDatasetRequest(request)}`,
			{ cache: 'no-store', credentials: 'same-origin' }
		);
		if (response.status === 400 || response.status === 404) throw new Refused('unavailable');
		if (!response.ok) throw new TypeError(`dataset answered ${response.status}`);
		const parsed = parseDatasetResponse(await response.json());
		if (parsed.name !== name) throw new Refused('bad-response');
		return parsed;
	};

	const write = async (
		staging: Staging,
		at: { cursor: number; schema: string },
		status: 'seeded' | 'reseeded' | 'patched'
	): Promise<DatasetOutcome> => {
		try {
			if (!(await store.commit(staging, at, epoch))) throw new Refused('epoch');
		} catch (error) {
			if (error instanceof Refused) throw error;
			throw new Refused('storage');
		}
		return { name, requests, status, cursor: at.cursor, rows: staging.rows.size };
	};

	const seed = async (
		first: DatasetResponse | undefined,
		status: 'seeded' | 'reseeded',
		retry: boolean
	): Promise<DatasetOutcome> => {
		let page = first ?? (await get({ name }));
		const { cursor, schema } = page;
		const budget = await deps.budget();
		const staging = store.stage(name);
		let matches: boolean | null;
		let after: string | undefined;
		for (let pages = 1; ; pages += 1) {
			if (deps.epoch() !== epoch) throw new Refused('epoch');
			matches = await staging.add(page);
			if (budget !== undefined && staging.bytes > budget) throw new Refused('budget');
			if (page.next === undefined) break;
			if (pages >= DATASET_MAX_PAGES || (after !== undefined && page.next <= after)) {
				throw new Refused('bad-response');
			}
			after = page.next;
			page = await get({ name, after });
		}
		if (matches === true) return write(staging, { cursor, schema }, status);
		// rows moved while the pages were read: the changes since the first page repair the copy
		const patch = await get({ name, since: cursor, schema });
		if (!patch.reset && (await staging.add(patch)) === true) {
			return write(staging, { cursor: patch.cursor, schema }, status);
		}
		if (retry) return seed(undefined, 'reseeded', false);
		throw new Refused('proof');
	};

	try {
		const held = await store.get(name);
		if (!held) return await seed(undefined, 'seeded', true);
		const { cursor, schema, digest, count } = held.meta;
		const response = await get({ name, since: cursor, schema });
		if (response.reset) return await seed(response, 'reseeded', true);
		if (response.cursor < cursor)
			return { name, requests, status: 'current', cursor, rows: count };
		const proof = response.proof;
		if (response.cursor === cursor) {
			// nothing moved; a proof that disagrees with the held rows means the copy is damaged
			if (proof && (proof.count !== count || proof.digest !== digest)) {
				await store.drop(name);
				return await seed(undefined, 'reseeded', false);
			}
			if (!(await store.touch(name, epoch))) throw new Refused('epoch');
			return { name, requests, status: 'current', cursor, rows: count };
		}
		const staging = store.stage(name, held);
		if ((await staging.add(response)) === true) {
			return await write(staging, { cursor: response.cursor, schema }, 'patched');
		}
		// the patched rows do not match the server's proof: nothing wrong is kept
		await store.drop(name);
		return await seed(undefined, 'reseeded', false);
	} catch (error) {
		if (error instanceof Refused)
			return { name, requests, status: 'refused', reason: error.reason };
		if (error instanceof ProtocolError) {
			return { name, requests, status: 'refused', reason: 'bad-response' };
		}
		return { name, requests, status: 'offline' };
	}
}
