/** anything with a `close()`, such as an `IDBDatabase` */
export type Closable = { close(): void };

/**
 * Closes `db` when the page is hidden. An open IndexedDB connection keeps a page out of the
 * back/forward cache, so the page reopens it on the next use. Returns a function that removes
 * the listener.
 */
export function closeOnPageHide(
	db: Closable,
	target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window
): () => void {
	const close = () => db.close();
	target.addEventListener('pagehide', close);
	return () => target.removeEventListener('pagehide', close);
}
