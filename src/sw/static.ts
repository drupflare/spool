/** prefix of the Cache that holds static bytes; the runtime version completes the name */
export const STATIC_CACHE = 'spool-static-';

/** largest file the worker keeps; a bigger response goes to the network every time */
export const MAX_STATIC_BYTES = 4 * 1024 * 1024;

/** response headers that describe the transfer or the connection, not the file, so they are not replayed */
const TRANSFER = [
	'content-encoding',
	'content-length',
	'transfer-encoding',
	'connection',
	'keep-alive',
	'set-cookie',
	'age',
	'date',
	'vary'
];

/** the headers to store with a file: everything but {@link TRANSFER} */
export function replayHeaders(headers: Headers): Headers {
	const out = new Headers(headers);
	for (const name of TRANSFER) out.delete(name);
	return out;
}

/**
 * Reads a body up to `cap` bytes. A longer body, announced by `content-length` or found by
 * counting, gives null and the rest is not read.
 */
export async function readCapped(response: Response, cap: number): Promise<Uint8Array | null> {
	if (Number(response.headers.get('content-length')) > cap) {
		// not awaited: a cancelled tee branch settles only once the other branch is read or cancelled
		void response.body?.cancel().catch(() => undefined);
		return null;
	}
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > cap) {
			// not awaited: a cancelled tee branch settles only once the other branch is read or cancelled
			void reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
}

/**
 * Splits a body into the visitor's stream and a capture stream, both fed by one read of `body`. A
 * tee drops the chunks a branch has not read yet when the source errors, so the visitor would lose
 * bytes the network already sent. Here the error reaches the visitor only after those chunks.
 */
export function splitBody(body: ReadableStream<Uint8Array>): {
	visitor: ReadableStream<Uint8Array>;
	capture: ReadableStream<Uint8Array>;
} {
	const reader = body.getReader();
	const held: Uint8Array[] = [];
	let end: { failed: boolean; reason?: unknown } | null = null;
	let wake = (): void => {};
	let open = true;
	let copy!: ReadableStreamDefaultController<Uint8Array>;
	const capture = new ReadableStream<Uint8Array>({
		start(controller) {
			copy = controller;
		},
		cancel() {
			open = false;
		}
	});
	const finish = (next: { failed: boolean; reason?: unknown }) => {
		end = next;
		wake();
	};
	void (async () => {
		for (;;) {
			let step: Awaited<ReturnType<typeof reader.read>>;
			try {
				step = await reader.read();
			} catch (reason) {
				if (open) copy.error(reason);
				return finish({ failed: true, reason });
			}
			if (step.done) {
				if (open) copy.close();
				return finish({ failed: false });
			}
			held.push(step.value);
			wake();
			if (open) copy.enqueue(step.value);
		}
	})();
	const visitor = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				for (;;) {
					const next = held.shift();
					if (next) return controller.enqueue(next);
					if (end?.failed) return controller.error(end.reason);
					if (end) return controller.close();
					await new Promise<void>((resolve) => (wake = resolve));
				}
			},
			cancel: (reason) => reader.cancel(reason)
		},
		{ highWaterMark: 0 }
	);
	return { visitor, capture };
}

/**
 * The response a visitor gets and the copy the runtime keeps from one network answer. Every body is
 * split (see {@link splitBody}), whatever its status. A redirect and a body-less answer are cloned,
 * because a split response would lose the redirect's url and a body-less one has no stream.
 */
export function branch(response: Response): { visitor: Response; copy: Response } {
	if (response.redirected || !response.body) {
		return { visitor: response, copy: response.clone() };
	}
	const { visitor, capture } = splitBody(response.body);
	const init = {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	};
	return { visitor: new Response(visitor, init), copy: new Response(capture, init) };
}

const HASH = /^sha(256|384|512)-([A-Za-z0-9+/]+={0,2})$/;
const TAG = /^(?:W\/)?"/;

function base64(bytes: Uint8Array): string {
	let text = '';
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text);
}

const stripWeak = (tag: string) => tag.replace(/^W\//, '');

/**
 * Whether `bytes` are the file a manifest `version` names. A `sha256-`, `sha384-` or `sha512-`
 * version must equal the digest of the bytes, and an entity tag must equal the response's `ETag`.
 * Any other version is a label the site chose, which nothing can check.
 */
export async function matchesVersion(
	version: string,
	bytes: Uint8Array,
	headers: Headers
): Promise<boolean> {
	const hash = HASH.exec(version);
	if (hash) {
		const digest = await crypto.subtle.digest(`SHA-${hash[1]}`, bytes as BufferSource);
		return base64(new Uint8Array(digest)) === hash[2];
	}
	if (TAG.test(version)) {
		const tag = headers.get('etag');
		return tag !== null && stripWeak(tag) === stripWeak(version);
	}
	return true;
}
