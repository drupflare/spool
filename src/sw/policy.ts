/** the response headers that carry a site's security policy; a local render replays them */
export const POLICY_HEADERS = [
	'content-security-policy',
	'content-security-policy-report-only',
	'x-frame-options',
	'x-content-type-options',
	'referrer-policy',
	'permissions-policy',
	'cross-origin-opener-policy',
	'cross-origin-embedder-policy',
	'cross-origin-resource-policy'
] as const;

/** most paths whose own header set is kept, oldest dropped first */
export const MAX_POLICY_PATHS = 128;

/** header names and values, as stored in the replica meta */
export type HeaderSet = Array<[string, string]>;

/** the pairs in `value` whose name is an allowed policy header, or undefined when `value` is not a list */
export function allowedPolicy(value: unknown): HeaderSet | undefined {
	if (!Array.isArray(value)) return undefined;
	const names: readonly string[] = POLICY_HEADERS;
	return value.filter(
		(pair): pair is [string, string] =>
			Array.isArray(pair) &&
			pair.length === 2 &&
			typeof pair[0] === 'string' &&
			typeof pair[1] === 'string' &&
			names.includes(pair[0])
	);
}

/** the {@link POLICY_HEADERS} a response carries, possibly none */
export function policyHeaders(headers: Headers): HeaderSet {
	const out: HeaderSet = [];
	for (const name of POLICY_HEADERS) {
		const value = headers.get(name);
		if (value !== null) out.push([name, value]);
	}
	return out;
}
