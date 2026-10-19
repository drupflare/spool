import { json } from '../server/sync.js';

/** where a CMS or a hook tells the proxy that tags changed */
export const PURGE_PATH = '/.spool/purge';

const MAX_BODY = 65_536;
const MAX_TAGS = 1000;
const MAX_TAG_LENGTH = 1024;

const encoder = new TextEncoder();
let macKey: Promise<CryptoKey> | undefined;

/** compares two secrets through HMAC digests of equal length, so neither the value nor its length shows in the time taken */
export async function equalSecrets(a: string, b: string): Promise<boolean> {
	macKey ??= crypto.subtle.importKey(
		'raw',
		crypto.getRandomValues(new Uint8Array(32)),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const key = await macKey;
	const digest = async (value: string) =>
		new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
	const left = await digest(a);
	const right = await digest(b);
	let diff = 0;
	for (let i = 0; i < left.length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 1);
	return diff === 0;
}

function bearer(request: Request): string | null {
	const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '');
	return match ? (match[1] as string).trim() : null;
}

function tagsOf(text: string): string[] | null {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return null;
	}
	const tags = (body as { tags?: unknown } | null)?.tags;
	if (!Array.isArray(tags) || tags.length === 0 || tags.length > MAX_TAGS) return null;
	for (const tag of tags) {
		if (typeof tag !== 'string' || tag === '' || tag.length > MAX_TAG_LENGTH) return null;
	}
	return [...new Set(tags as string[])];
}

/**
 * Answers `POST /.spool/purge`. The caller sends `Authorization: Bearer <secret>` and a JSON body
 * `{"tags": ["node:1", ...]}`. With no secret configured every call is refused, so a proxy that
 * never asked for purges cannot be made to bump its vector.
 */
export async function respondPurge(
	request: Request,
	secret: string | undefined,
	apply: (tags: string[]) => Promise<number>
): Promise<Response> {
	if (request.method !== 'POST') return json({ error: 'use POST' }, 405, { allow: 'POST' });
	if (!secret) return json({ error: 'purge is not configured' }, 403);
	const given = bearer(request);
	if (given === null || !(await equalSecrets(given, secret))) {
		return json({ error: 'bad credentials' }, 401, { 'www-authenticate': 'Bearer' });
	}
	const length = Number(request.headers.get('content-length'));
	if (Number.isFinite(length) && length > MAX_BODY) return json({ error: 'body too large' }, 413);
	const text = await request.text();
	if (text.length > MAX_BODY) return json({ error: 'body too large' }, 413);
	const tags = tagsOf(text);
	if (!tags) return json({ error: 'send {"tags": [...]} with 1 to 1000 tags' }, 400);
	return json({ vector: await apply(tags), tags: tags.length });
}
