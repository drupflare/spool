/** the localStorage key the time of the last contact with the server is kept under */
export const CONTACT_KEY = 'spool:contact';

/** whether the page's copy of the last server contact is older than the worker script's lease */
export type LeaseClock = {
	/** true when no contact is known, the last one is past the lease, or the clock moved back */
	due(): boolean;
	/** records a server contact at `at`, in milliseconds since the epoch */
	mark(at: number): void;
};

function localStorageOrUndefined(): Storage | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}

/**
 * Keeps the time of the last server contact for the lease of `leaseSec` seconds. The page reads it
 * from localStorage; when the store is missing or fails, the page's own record stands in for it, so
 * a failing store asks the server once per page load and never throws.
 */
export function leaseClock(
	leaseSec: number,
	storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = localStorageOrUndefined(),
	now: () => number = Date.now
): LeaseClock {
	let memory = 0;
	const read = (): number | undefined => {
		let stored = 0;
		try {
			stored = Number(storage?.getItem(CONTACT_KEY));
		} catch {
			// the page's own record stands in
		}
		const at = Math.max(Number.isFinite(stored) ? stored : 0, memory);
		return at > 0 ? at : undefined;
	};
	return {
		due() {
			const at = read();
			if (at === undefined) return true;
			const age = now() - at;
			return !(age >= 0 && age < leaseSec * 1000);
		},
		mark(at) {
			memory = Math.max(memory, at);
			try {
				storage?.setItem(CONTACT_KEY, String(memory));
			} catch {
				// the page's own record covers this page load
			}
		}
	};
}

let lease: { clock: LeaseClock; registration: ServiceWorkerRegistration } | undefined;

/** starts the page's lease clock once the worker has reported its lease */
export function holdLease(registration: ServiceWorkerRegistration, leaseSec: number): void {
	lease = { clock: leaseClock(leaseSec), registration };
}

/** records a contact the worker saw; a page without a lease ignores it */
export function markContact(at: number): void {
	lease?.clock.mark(at);
}

/**
 * Asks the browser for the worker script once the lease has passed. The mark comes first, so
 * views inside the next lease make no request. Called on each page load and each in-page view.
 */
export function checkLease(): void {
	if (!lease || !lease.clock.due()) return;
	lease.clock.mark(Date.now());
	void lease.registration.update().catch(() => undefined);
}
