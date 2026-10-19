import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http, {
	type IncomingHttpHeaders,
	type IncomingMessage,
	type ServerResponse
} from 'node:http';
import https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls, { TLSSocket, type SecureContext } from 'node:tls';

/** one request as it left for the origin: the proxy's own count, not the browser's */
export type WireEntry = {
	/** epoch milliseconds the response finished */
	at: number;
	host: string;
	method: string;
	/** the path without its query string */
	path: string;
	/** 0 when the origin never answered */
	status: number;
	/** request line, headers and body, HTTP/1.1 text sizes */
	requestBytes: number;
	/** status line, headers and body, HTTP/1.1 text sizes */
	responseBytes: number;
	/** the response body alone, as sent (compressed when the origin compressed it) */
	bodyBytes: number;
};

/** what a stretch of {@link WireEntry} rows adds up to */
export type WireSummary = {
	requests: number;
	/** request and response bytes together */
	bytes: number;
	/** status lines, headers and bodies, the part a browser's `encodedDataLength` also counts */
	responseBytes: number;
	bodyBytes: number;
	byStatus: Record<string, number>;
	/** requests to the page's own host, and to every other host */
	sameHost: number;
	thirdParty: number;
	hosts: number;
};

/** requests, bytes and statuses over `entries`; `siteHost` splits own-host from third-party requests */
export function summarise(entries: readonly WireEntry[], siteHost?: string): WireSummary {
	const byStatus: Record<string, number> = {};
	let bytes = 0;
	let responseBytes = 0;
	let bodyBytes = 0;
	let sameHost = 0;
	for (const e of entries) {
		byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
		bytes += e.requestBytes + e.responseBytes;
		responseBytes += e.responseBytes;
		bodyBytes += e.bodyBytes;
		if (e.host === siteHost) sameHost += 1;
	}
	return {
		requests: entries.length,
		bytes,
		responseBytes,
		bodyBytes,
		byStatus,
		sameHost,
		thirdParty: siteHost === undefined ? 0 : entries.length - sameHost,
		hosts: new Set(entries.map((e) => e.host)).size
	};
}

const HOP = new Set([
	'connection',
	'proxy-connection',
	'keep-alive',
	'proxy-authorization',
	'te',
	'upgrade'
]);

const rawBytes = (raw: readonly string[], skipHop = false) => {
	let n = 0;
	for (let i = 0; i + 1 < raw.length; i += 2) {
		if (skipHop && HOP.has((raw[i] as string).toLowerCase())) continue;
		n += (raw[i] as string).length + (raw[i + 1] as string).length + 4;
	}
	return n;
};

/** a throwaway certificate authority and the leaf certificates it issues, made with the `openssl` binary */
export type Ca = {
	/** PEM of the root, for a client that must trust it */
	certPem: string;
	contextFor(host: string): SecureContext;
};

/** makes a CA under `dir` (a new temp folder by default); needs `openssl` on the path */
export function createCa(dir: string = mkdtempSync(join(tmpdir(), 'wire-ca-'))): Ca {
	mkdirSync(dir, { recursive: true });
	const run = (...args: string[]) => {
		const result = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
		if (result.status !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr}`);
	};
	const curve = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
	run(
		'req',
		'-x509',
		...curve,
		'-keyout',
		'ca.key',
		'-out',
		'ca.crt',
		'-days',
		'2',
		'-subj',
		'/CN=spool-wire-ca'
	);
	run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key');
	const key = readFileSync(join(dir, 'leaf.key'), 'utf8');
	const cache = new Map<string, SecureContext>();
	return {
		certPem: readFileSync(join(dir, 'ca.crt'), 'utf8'),
		contextFor(host) {
			const hit = cache.get(host);
			if (hit) return hit;
			const stem = host.replace(/[^a-z0-9.-]/gi, '_');
			const isIp = /^[\d.]+$/.test(host) || host.includes(':');
			writeFileSync(
				join(dir, `${stem}.ext`),
				`subjectAltName=${isIp ? 'IP' : 'DNS'}:${host}\n`
			);
			run('req', '-new', '-key', 'leaf.key', '-subj', `/CN=${host}`, '-out', `${stem}.csr`);
			run(
				'x509',
				'-req',
				'-in',
				`${stem}.csr`,
				'-CA',
				'ca.crt',
				'-CAkey',
				'ca.key',
				'-CAcreateserial',
				'-days',
				'2',
				'-extfile',
				`${stem}.ext`,
				'-out',
				`${stem}.crt`
			);
			const context = tls.createSecureContext({
				key,
				cert: readFileSync(join(dir, `${stem}.crt`), 'utf8')
			});
			cache.set(host, context);
			return context;
		}
	};
}

export type WireProxyOptions = {
	/** reverse mode: forward everything to this `host:port` (plain HTTP), like a tunnel in front of one origin */
	target?: string;
	/** forward mode: decrypt CONNECT tunnels with this CA so HTTPS requests can be counted */
	ca?: Ca;
	/** PEM roots to trust for the origin leg, on top of the system roots (for a local test origin) */
	upstreamCa?: string;
};

export type WireProxy = {
	port: number;
	/** `http://127.0.0.1:<port>`, a proxy server for a browser or the origin address in reverse mode */
	url: string;
	entries: WireEntry[];
	/** the current length of `entries`, to pass to `summarise(entries.slice(mark))` later */
	mark(): number;
	/** resolves once no request is in flight */
	idle(): Promise<void>;
	stop(): Promise<void>;
};

/**
 * A counting HTTP proxy between a browser and an origin, in the shape of the worker's
 * `delay-proxy`: it adds no delay and changes no byte, and records every request that reaches the
 * origin. Reverse mode forwards to one plain-HTTP `target`; forward mode is a browser proxy, and
 * with a `ca` it decrypts `CONNECT` tunnels (HTTP/1.1 only) so HTTPS requests are counted too.
 */
export async function startWireProxy(options: WireProxyOptions = {}): Promise<WireProxy> {
	const entries: WireEntry[] = [];
	let inflight = 0;
	const waiting: Array<() => void> = [];
	const settle = () => {
		if (inflight === 0) for (const done of waiting.splice(0)) done();
	};

	const relay = (
		req: IncomingMessage,
		res: ServerResponse,
		scheme: 'http' | 'https',
		host: string,
		port: number
	) => {
		const url = new URL(req.url ?? '/', 'http://x');
		const path = req.url?.startsWith('/') ? req.url : `${url.pathname}${url.search}`;
		const headers: IncomingHttpHeaders = {};
		for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
		let requestBytes =
			`${req.method} ${path} HTTP/1.1\r\n\r\n`.length + rawBytes(req.rawHeaders, true);
		let responseBytes = 0;
		let bodyBytes = 0;
		let status = 0;
		inflight += 1;
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			entries.push({
				at: Date.now(),
				host,
				method: req.method ?? 'GET',
				path: path.split('?')[0] as string,
				status,
				requestBytes,
				responseBytes: responseBytes + bodyBytes,
				bodyBytes
			});
			inflight -= 1;
			settle();
		};
		const transport = scheme === 'https' ? https : http;
		const upstream = transport.request(
			{
				host,
				port,
				method: req.method,
				path,
				headers,
				...(scheme === 'https' && options.upstreamCa ? { ca: options.upstreamCa } : {})
			},
			(answer) => {
				status = answer.statusCode ?? 0;
				responseBytes =
					`HTTP/1.1 ${status} ${answer.statusMessage ?? ''}\r\n\r\n`.length +
					rawBytes(answer.rawHeaders);
				const out: IncomingHttpHeaders = {};
				for (const [k, v] of Object.entries(answer.headers)) if (!HOP.has(k)) out[k] = v;
				res.writeHead(status, out as Record<string, string | string[]>);
				answer.on('data', (chunk: Buffer) => {
					bodyBytes += chunk.length;
					res.write(chunk);
				});
				answer.on('end', () => {
					res.end();
					finish();
				});
				answer.on('error', () => {
					res.destroy();
					finish();
				});
			}
		);
		res.on('close', () => {
			if (!res.writableFinished) upstream.destroy();
		});
		upstream.on('error', () => {
			if (!res.headersSent) res.writeHead(502);
			res.end();
			finish();
		});
		req.on('data', (chunk: Buffer) => {
			requestBytes += chunk.length;
		});
		req.pipe(upstream);
	};

	const [targetHost, targetPort] = (options.target ?? '').split(':');
	const handler = (req: IncomingMessage, res: ServerResponse) => {
		if (options.target)
			return relay(req, res, 'http', targetHost as string, Number(targetPort));
		const url = new URL(req.url ?? '/');
		relay(req, res, 'http', url.hostname, Number(url.port || 80));
	};
	const server = http.createServer(handler);
	server.on('connect', (req, client: Socket) => {
		const ca = options.ca;
		if (!ca) {
			client.end('HTTP/1.1 501 Not Implemented\r\n\r\n');
			return;
		}
		const [host, port] = (req.url ?? '').split(':') as [string, string];
		client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
		const secure = new TLSSocket(client, {
			isServer: true,
			secureContext: ca.contextFor(host),
			ALPNProtocols: ['http/1.1']
		});
		secure.on('error', () => client.destroy());
		const inner = http.createServer((r, s) => relay(r, s, 'https', host, Number(port || 443)));
		inner.emit('connection', secure);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		port,
		url: `http://127.0.0.1:${port}`,
		entries,
		mark: () => entries.length,
		idle: () =>
			inflight === 0
				? Promise.resolve()
				: new Promise<void>((resolve) => waiting.push(resolve)),
		stop: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			})
	};
}
