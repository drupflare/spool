import type { Identity } from '../protocol/route.js';

/** how a request becomes a principal; the secret keys the partition id */
export type IdentityOptions = {
	resolve(request: Request): Identity | null | Promise<Identity | null>;
	secret: string | Uint8Array;
};

function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The `Spool-Partition` value for a principal: an HMAC-SHA-256 under the server secret, so the
 * browser can tell partitions apart without learning the principal, and one principal's id cannot
 * be computed from another's.
 */
export async function partitionId(secret: string | Uint8Array, principal: string): Promise<string> {
	const raw = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
	const key = await crypto.subtle.importKey(
		'raw',
		raw as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const mac = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(`spool-partition:1\u0000${principal}`)
	);
	return base64url(new Uint8Array(mac));
}
