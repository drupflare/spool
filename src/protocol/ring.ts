import type { BundleRows } from './bundle.js';
import type { SerializedRoute } from './route.js';
import type { CompiledTemplate } from './template/compile.js';
import type { ResourceWrite } from './write.js';

/** the id of the JSON script element that carries a ring in the first document */
export const RING_ELEMENT_ID = 'spool-ring';

/** the id of the JSON script element that carries the declared writes of a page with no ring */
export const WRITES_ELEMENT_ID = 'spool-writes';

/** the id of the element that carries a delta to a no-worker page that holds an older version */
export const DELTA_ELEMENT_ID = 'spool-delta';

/** when a client fetches the pack and the worker: `second-view` is pack on view two, worker on view three */
export type BootstrapGate = 'first-view' | 'second-view';

/**
 * whether a page registers the worker. `never` keeps every read in the page. `auto` registers it,
 * except on WebKit for a page that carries a ring: WebKit checks the worker script on each
 * navigation, which costs more than it saves. `always` registers it on WebKit too.
 */
export type WorkerMode = 'auto' | 'never' | 'always';

/**
 * The records a first document carries so the second view needs no request: the entry page and
 * its link neighbours up to a byte budget, the routes that render them, and where the full pack is.
 * A ring is trusted as far as the document that carried it; the pack that follows is verified.
 */
export type Ring = {
	protocol: 1;
	/** the pack version the rows belong to */
	version: number;
	/** the set digest of the whole pack at that version */
	digest: string;
	/** absent on a gate page, where the boot script the ring names carries the routes and templates */
	routes?: SerializedRoute[];
	/** the compiled template of each route in `routes` that has one, keyed by route pattern; absent with `routes` */
	templates?: Record<string, CompiledTemplate>;
	/** rows by table, ascending by key */
	tables: Record<string, BundleRows>;
	/** true when the ring holds every row, so no pack is fetched */
	complete: boolean;
	bootstrap: BootstrapGate;
	/** an `always` site writes `auto` here, so a client that predates `always` reads the ring as it does an `auto` one */
	worker: 'auto' | 'never';
	/** true when the site registers the worker on WebKit too (`workerMode: 'always'`); absent otherwise */
	webkitWorker?: true;
	/** where the pack is and how many bytes it is; absent when `complete` */
	pack?: { url: string; bytes: number };
	/** the worker script's lease in seconds; the worker's views inside one lease make the third; absent on an older ring */
	lease?: number;
	/**
	 * the boot script that carries the runtime, this pack, and on a gate page the routes and
	 * templates in one response; absent when the page loads the runtime by its own tag. A gate page
	 * adds `?r=<id>`, the id of those routes and templates, so a changed template is a new URL.
	 */
	boot?: string;
	/** the declared resource writes, so a no-worker page can send them through `spool.fetch`; absent when none */
	writes?: ResourceWrite[];
};
