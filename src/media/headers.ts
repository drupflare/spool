/** what a request says about the visitor's connection */
export type MediaSignals = {
	/** `Save-Data: on` */
	saveData: boolean;
	/** `ECT` of `slow-2g`, `2g` or `3g` */
	slow: boolean;
};

/** the connection signals in a request's `Save-Data` and `ECT` headers */
export function signalsOf(headers: Headers): MediaSignals {
	const ect = (headers.get('ect') ?? '').trim().toLowerCase();
	return {
		saveData: (headers.get('save-data') ?? '').trim().toLowerCase() === 'on',
		slow: ect === 'slow-2g' || ect === '2g' || ect === '3g'
	};
}

/** adds each name to a comma-separated header, skipping any it already lists in any case */
export function mergeList(headers: Headers, name: string, additions: readonly string[]): void {
	const current = headers.get(name);
	const have = (current ?? '')
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part !== '');
	if (have.includes('*')) return;
	const lower = new Set(have.map((part) => part.toLowerCase()));
	const added = additions.filter((part) => !lower.has(part.toLowerCase()));
	if (added.length === 0) return;
	headers.set(name, [...have, ...added].join(', '));
}

/** makes `Cache-Control` private: `public` becomes `private`, and a header with none gets `private, max-age=0` */
export function makePrivate(headers: Headers): void {
	const value = headers.get('cache-control');
	if (!value) {
		headers.set('cache-control', 'private, max-age=0');
		return;
	}
	const parts = value
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part !== '');
	const names = parts.map((part) => (part.split('=')[0] ?? '').trim().toLowerCase());
	if (names.includes('private')) return;
	const at = names.indexOf('public');
	if (at >= 0) parts[at] = 'private';
	else parts.unshift('private');
	headers.set('cache-control', parts.join(', '));
}
