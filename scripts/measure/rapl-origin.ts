import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';

type Manifest = {
	pages: string[];
	files: Record<string, { file: string; type: string; bytes: number }>;
};

type Stored = { body: Buffer; type: string; etag: string };

const etagOf = (body: Buffer) => `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;

/** the mirror's files by `path?query`, read once, with an ETag each */
export function loadMirror(dir: string): { manifest: Manifest; files: Record<string, Stored> } {
	const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
	const files: Record<string, Stored> = {};
	for (const [key, f] of Object.entries(manifest.files)) {
		const body = readFileSync(join(dir, 'files', f.file));
		files[key] = { body, type: f.type, etag: etagOf(body) };
	}
	return { manifest, files };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** the worker both origins serve: pages and assets from CacheStorage, RUM beacons queued until a flush message */
const worker = (version: string, pages: string[], assets: string[]) =>
	`const V=${JSON.stringify(version)};const PAGES=${JSON.stringify(pages)};const ASSETS=${JSON.stringify(assets)};
self.addEventListener('install',e=>e.waitUntil(caches.open(V).then(c=>c.addAll([...PAGES,...ASSETS])).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
const Q=[];self.addEventListener('message',e=>{if(e.data==='flush'&&Q.length){const b=JSON.stringify(Q.splice(0));e.waitUntil(fetch('/cdn-cgi/rum',{method:'POST',body:b}))}});self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(u.pathname==='/cdn-cgi/rum'&&e.request.method==='POST'){e.respondWith(e.request.text().then(t=>{Q.push(t);return new Response(null,{status:204})}));return}if(e.request.mode==='navigate'){if(PAGES.includes(u.pathname))e.respondWith(caches.match(u.pathname));return}e.respondWith(caches.match(u.pathname+u.search).then(r=>r||fetch(e.request)))});`;

/**
 * The origin of the views experiment: a static mirror on two ports with the same bytes and
 * different headers, plus `/spool-sw.js` on the first. Port `optimized` serves immutable assets and
 * revalidated pages; port `shipping` sends `max-age=0` on everything, as the demo did. `stats` has
 * the hit counts, the paths and the process CPU.
 */
export function startViewsOrigin(options: {
	mirror: string;
	rttMs: number;
	optimized: number;
	shipping: number;
	stats: number;
}) {
	const { manifest, files } = loadMirror(options.mirror);
	const assets = Object.keys(manifest.files).filter((k) => !manifest.pages.includes(k));
	const sw = worker('spool-rig-1', manifest.pages, assets);
	const hits: Record<number, number> = { [options.optimized]: 0, [options.shipping]: 0 };
	const paths: Record<number, Record<string, number>> = {
		[options.optimized]: {},
		[options.shipping]: {}
	};
	const handler = (port: number) => (req: IncomingMessage, res: ServerResponse) => {
		hits[port] = (hits[port] as number) + 1;
		const path = new URL(req.url ?? '/', 'http://x').pathname;
		const seen = paths[port] as Record<string, number>;
		seen[path] = (seen[path] ?? 0) + 1;
		setTimeout(() => {
			const url = new URL(req.url ?? '/', 'http://x');
			if (url.pathname === '/spool-sw.js' && port === options.optimized) {
				res.writeHead(200, {
					'content-type': 'text/javascript',
					'cache-control': 'max-age=86400'
				});
				return void res.end(sw);
			}
			if (url.pathname === '/cdn-cgi/rum') {
				res.writeHead(204);
				return void res.end();
			}
			const f = files[url.pathname + url.search] ?? files[url.pathname];
			if (!f) {
				res.writeHead(404);
				return void res.end();
			}
			const cc =
				port === options.shipping || manifest.pages.includes(url.pathname)
					? 'public, max-age=0, must-revalidate'
					: 'public, max-age=31536000, immutable';
			if (req.headers['if-none-match'] === f.etag) {
				res.writeHead(304, { etag: f.etag, 'cache-control': cc });
				return void res.end();
			}
			res.writeHead(200, { 'content-type': f.type, etag: f.etag, 'cache-control': cc });
			res.end(f.body);
		}, options.rttMs);
	};
	createServer(handler(options.optimized)).listen(options.optimized, '127.0.0.1');
	createServer(handler(options.shipping)).listen(options.shipping, '127.0.0.1');
	createServer((_, res) => {
		const cpu = process.cpuUsage();
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ hits, paths, cpuUs: cpu.user + cpu.system }));
	}).listen(options.stats, '127.0.0.1');
}

const esc = (s: unknown) =>
	String(s).replace(
		/[&<>"]/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string
	);

const row = (o: Record<string, unknown>) =>
	`<tr>${Object.values(o)
		.map((v) => `<td>${typeof v === 'number' ? Math.round(v * 100) / 100 : esc(v)}</td>`)
		.join('')}</tr>`;

/** the page script of the `pk` route: fetches one department's records and aggregates them in the page */
export const PROJECTION_SCRIPT = `(async()=>{const d=await (await fetch(location.pathname.replace(/^.*\\/pk\\//,'/data/dept-')+'.json')).json();
const T={},C={};for(const [t,c,cr,g,st] of d){const x=T[t]??={n:0,ch:0,gs:0,gn:0};x.n++;x.ch+=cr;if(g!==null){x.gs+=g;x.gn++}const y=C[c]??={n:0,bad:0};y.n++;if(st>0)y.bad++}
const a=Object.entries(T).sort((p,q)=>p[0]-q[0]).map(([t,x])=>[t,x.n,x.ch,x.gn?x.gs/x.gn:null]);
const b=Object.entries(C).filter(([,y])=>y.n>=30).map(([c,y])=>[c,y.n,100*y.bad/y.n]).sort((p,q)=>q[2]-p[2]).slice(0,15);
const sec=document.createElement('section');sec.className='spool-rig-proj';for(const rows of [a,b]){const tb=document.createElement('table');for(const r of rows){const tr=document.createElement('tr');for(const v of r){const td=document.createElement('td');td.textContent=typeof v==='number'?Math.round(v*100)/100:v;tr.appendChild(td)}tb.appendChild(tr)}sec.appendChild(tb)}document.body.appendChild(sec)})()`;

/**
 * The origin of the compute experiments. Routes are `/<mode>/<kind>/<n>`: mode `r` recomputes on
 * every request, `c` answers from an in-process cache, `s` is the page a worker is provisioned
 * with. Kinds: `cms` (12 queries, a template, gzip), `ana` (department queries and a scan),
 * `ps` and `pk` (the projection result computed on the server or in the page), `ai` (a model
 * call). `/__null` is the transaction floor, `/__stats` has counters and process CPU.
 */
export function startComputeOrigin(options: {
	mirror: string;
	data: string;
	port: number;
	rttMs: number;
	benchTerms: number;
	ollama: string;
	model: string;
}) {
	const { manifest, files } = loadMirror(options.mirror);
	const assets = Object.keys(manifest.files).filter((k) => !manifest.pages.includes(k));
	const baseHtml = manifest.pages.map((p) => (files[p] as Stored).body.toString('utf8'));
	const cms = new DatabaseSync(join(options.data, 'cms.sqlite'), { readOnly: true });
	const ana = new DatabaseSync(join(options.data, 'enroll.sqlite'), { readOnly: true });
	const q = {
		node: cms.prepare(
			'SELECT n.*, u.name AS author FROM nodes n JOIN users u ON u.id=n.uid WHERE n.id=?'
		),
		tags: cms.prepare(
			'SELECT t.name FROM node_terms nt JOIN terms t ON t.id=nt.term_id WHERE nt.node_id=?'
		),
		menu: cms.prepare('SELECT id,parent,title,path FROM menu ORDER BY parent,weight'),
		blocks: cms.prepare('SELECT title,body FROM blocks WHERE region=? ORDER BY weight'),
		related: cms.prepare(
			'SELECT DISTINCT n.id,n.title FROM node_terms a JOIN node_terms b ON b.term_id=a.term_id JOIN nodes n ON n.id=b.node_id WHERE a.node_id=? AND n.id<>? ORDER BY n.created DESC LIMIT 10'
		),
		comments: cms.prepare(
			'SELECT c.body,u.name FROM comments c JOIN users u ON u.id=c.uid WHERE c.node_id=? ORDER BY c.created DESC LIMIT 20'
		),
		terms: ana.prepare(
			`SELECT t.seq, t.label, COUNT(*) enr, SUM(c.credits) ch, AVG(e.grade_points) gpa FROM courses c JOIN sections s ON s.course_id=c.id JOIN enrollments e ON e.section_id=s.id JOIN terms t ON t.id=s.term_id WHERE c.dept_id=? AND e.status IN ('A','D','W') GROUP BY t.id ORDER BY t.seq`
		),
		dfw: ana.prepare(
			`SELECT c.id, COUNT(*) n, 100.0*SUM(e.status IN ('D','W'))/COUNT(*) dfw FROM courses c JOIN sections s ON s.course_id=c.id JOIN enrollments e ON e.section_id=s.id WHERE c.dept_id=? GROUP BY c.id HAVING n>=30 ORDER BY dfw DESC LIMIT 15`
		),
		retain: ana.prepare(
			`WITH act AS (SELECT DISTINCT e.student_id sid, s.term_id tid FROM enrollments e JOIN sections s ON s.id=e.section_id WHERE e.student_id IN (SELECT id FROM students WHERE major_dept_id=?)) SELECT a.tid, COUNT(*) n, COUNT(b.sid) kept FROM act a LEFT JOIN act b ON b.sid=a.sid AND b.tid=a.tid+1 GROUP BY a.tid ORDER BY a.tid`
		),
		fill: ana.prepare(
			`SELECT s.term_id, ROUND(1.0*COUNT(e.student_id)/s.capacity,1) bucket, COUNT(DISTINCT s.id) sections FROM courses c JOIN sections s ON s.course_id=c.id LEFT JOIN enrollments e ON e.section_id=s.id WHERE c.dept_id=? GROUP BY s.id`
		),
		bench: ana.prepare(
			`SELECT c.dept_id, COUNT(*) n, AVG(e.grade_points) gpa, 100.0*SUM(e.status IN ('D','W'))/COUNT(*) dfw FROM enrollments e JOIN sections s ON s.id=e.section_id JOIN courses c ON c.id=s.course_id WHERE s.term_id>? GROUP BY c.dept_id`
		),
		rows: ana.prepare(
			`SELECT s.term_id t, c.id c, c.credits cr, e.grade_points g, e.status st FROM courses c JOIN sections s ON s.course_id=c.id JOIN enrollments e ON e.section_id=s.id WHERE c.dept_id=?`
		)
	};
	const inject = (n: number, fragment: string) =>
		(baseHtml[n % baseHtml.length] as string).replace('</body>', `${fragment}</body>`);

	const renderCms = (n: number) => {
		const id = 1 + (n % 5000);
		const node = q.node.get(id) as Record<string, unknown>;
		const tags = (q.tags.all(id) as Array<{ name: string }>).map((t) => t.name);
		const menu = q.menu.all() as Array<{ path: string; title: string }>;
		const regions = ['header', 'sidebar', 'footer', 'content_top'].map(
			(r) => q.blocks.all(r) as Array<{ title: string; body: string }>
		);
		const related = q.related.all(id, id) as Array<{ id: number; title: string }>;
		const comments = q.comments.all(id) as Array<{ name: string; body: string }>;
		return inject(
			n,
			`<section class="spool-rig-cms"><h1>${esc(node.title)}</h1><p>${esc(node.author)}</p><div>${esc(node.body)}</div><ul>${tags.map((t) => `<li>${esc(t)}</li>`).join('')}</ul><nav>${menu.map((x) => `<a href="${esc(x.path)}">${esc(x.title)}</a>`).join('')}</nav>${regions.map((rg) => rg.map((b) => `<aside><h2>${esc(b.title)}</h2>${esc(b.body)}</aside>`).join('')).join('')}<ul>${related.map((x) => `<li><a href="/node/${x.id}">${esc(x.title)}</a></li>`).join('')}</ul>${comments.map((c) => `<article><b>${esc(c.name)}</b> ${esc(c.body)}</article>`).join('')}</section>`
		);
	};
	const analytics = (d: number) => {
		const dept = 1 + (d % 60);
		return {
			dept,
			a: q.terms.all(dept),
			b: q.dfw.all(dept),
			c: q.retain.all(dept),
			fillRows: q.fill.all(dept).length,
			bench: q.bench.all(24 - options.benchTerms)
		};
	};
	const table = (rows: unknown[]) =>
		`<table>${(rows as Array<Record<string, unknown>>).map(row).join('')}</table>`;
	const renderAna = (n: number) => {
		const r = analytics(n);
		return inject(
			n,
			`<section class="spool-rig-ana"><h1>Department ${r.dept}</h1>${table(r.a)}${table(r.b)}${table(r.c)}${table(r.bench)}<p>${r.fillRows} sections</p></section>`
		);
	};
	const renderProjServer = (n: number) => {
		const dept = 1 + (n % 60);
		return inject(
			n,
			`<section class="spool-rig-proj"><h1>Department ${dept}</h1>${table(q.terms.all(dept))}${table(q.dfw.all(dept))}</section>`
		);
	};
	const renderProjClient = (n: number) => inject(n, `<script>${PROJECTION_SCRIPT}</script>`);

	const status: Record<string, number> = { A: 0, D: 1, W: 2 };
	const records = new Map<number, Buffer>();
	const deptRows = (d: number) => {
		let v = records.get(d);
		if (!v) {
			const all = q.rows.all(d) as Array<{
				t: number;
				c: number;
				cr: number;
				g: number | null;
				st: string;
			}>;
			v = Buffer.from(JSON.stringify(all.map((r) => [r.t, r.c, r.cr, r.g, status[r.st]])));
			records.set(d, v);
		}
		return v;
	};

	const ai = { calls: 0, last: null as unknown, out: 0, inp: 0 };
	const aiStats: Record<number, ReturnType<typeof analytics>> = {};
	const renderAi = async (n: number) => {
		const d = 1 + (n % 60);
		const stats = (aiStats[d] ??= analytics(d));
		const prompt = `You are an assistant for a university registrar. Summarize these department enrollment statistics for department ${d} in three sentences. Data: ${JSON.stringify({ terms: stats.a.slice(-8), dfw: stats.b.slice(0, 5), retention: stats.c.slice(-6) })}`;
		const res = await fetch(`${options.ollama}/api/generate`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: options.model,
				prompt,
				stream: false,
				keep_alive: '10m',
				options: { temperature: 0, seed: 7, num_predict: 120 }
			})
		});
		const j = (await res.json()) as {
			response?: string;
			eval_count?: number;
			prompt_eval_count?: number;
		};
		ai.calls++;
		ai.out += j.eval_count ?? 0;
		ai.inp += j.prompt_eval_count ?? 0;
		return inject(
			n,
			`<section class="spool-rig-ai"><h1>Department ${d}</h1><p>${esc(j.response ?? '')}</p></section>`
		);
	};

	const pages = [
		'/s/cms/1',
		'/s/cms/2',
		'/s/cms/3',
		'/s/cms/4',
		'/s/ana/1',
		'/s/ana/2',
		'/s/ana/3',
		'/s/ana/4'
	];
	const sw = worker('spool-rig-3', pages, assets);
	const projectionPages = ['/s/pk/1', '/s/pk/2', '/s/pk/3', '/s/pk/4'];
	const swProjection = worker('spool-rig-p', projectionPages, [
		...[1, 2, 3, 4].map((i) => `/data/dept-${i}.json`),
		...assets
	]);

	const kinds: Record<string, (n: number) => string | Promise<string>> = {
		cms: renderCms,
		ana: renderAna,
		ai: renderAi,
		ps: renderProjServer,
		pk: renderProjClient
	};
	type Entry = { raw: Buffer; gz: Buffer; etag: string };
	const cache = new Map<string, Entry>();
	const stats = { reqs: 0, recompute: 0, cacheHit: 0, cacheMiss: 0, n304: 0 };
	const build = (html: string): Entry => {
		const raw = Buffer.from(html);
		return { raw, gz: gzipSync(raw, { level: 6 }), etag: etagOf(raw) };
	};

	async function page(
		req: IncomingMessage,
		res: ServerResponse,
		mode: string,
		kind: string,
		n: number,
		gz: boolean
	) {
		let ent: Entry | undefined;
		if (mode === 'c' || mode === 's') {
			const key = `${kind}/${n}`;
			ent = cache.get(key);
			if (ent) stats.cacheHit++;
			else {
				stats.cacheMiss++;
				ent = build(await (kinds[kind] as (n: number) => string | Promise<string>)(n));
				cache.set(key, ent);
			}
		} else {
			stats.recompute++;
			ent = build(await (kinds[kind] as (n: number) => string | Promise<string>)(n));
		}
		const headers: Record<string, string> = {
			'content-type': 'text/html; charset=utf-8',
			etag: ent.etag,
			'cache-control': mode === 's' ? 'no-store' : 'public, max-age=0, must-revalidate'
		};
		if (req.headers['if-none-match'] === ent.etag && mode !== 's') {
			stats.n304++;
			res.writeHead(304, headers);
			return void res.end();
		}
		if (gz) headers['content-encoding'] = 'gzip';
		res.writeHead(200, headers);
		res.end(gz ? ent.gz : ent.raw);
	}

	const go = async (req: IncomingMessage, res: ServerResponse) => {
		stats.reqs++;
		const url = new URL(req.url ?? '/', 'http://x');
		const gz = /gzip/.test(String(req.headers['accept-encoding'] ?? ''));
		const route = /^\/([rcs])\/(cms|ana|ai|ps|pk)\/(\d+)$/.exec(url.pathname);
		if (route)
			return page(req, res, route[1] as string, route[2] as string, Number(route[3]), gz);
		const dept = /^\/data\/dept-(\d+)\.json$/.exec(url.pathname);
		if (dept) {
			res.writeHead(200, {
				'content-type': 'application/json',
				'cache-control': 'public, max-age=31536000, immutable'
			});
			return void res.end(deptRows(1 + (Number(dept[1]) % 60)));
		}
		const text = (body: string) => {
			res.writeHead(200, {
				'content-type': 'text/javascript',
				'cache-control': 'max-age=86400'
			});
			res.end(body);
		};
		if (url.pathname === '/spool-sw-proj.js') return text(swProjection);
		if (url.pathname === '/spool-sw.js') return text(sw);
		if (url.pathname === '/__null' || url.pathname === '/cdn-cgi/rum') {
			res.writeHead(204);
			return void res.end();
		}
		if (url.pathname === '/__stats') {
			const cpu = process.cpuUsage();
			res.writeHead(200, { 'content-type': 'application/json' });
			return void res.end(JSON.stringify({ ...stats, cpuUs: cpu.user + cpu.system, ai }));
		}
		const f = files[url.pathname + url.search] ?? files[url.pathname];
		if (!f) {
			res.writeHead(404);
			return void res.end();
		}
		const cc = 'public, max-age=31536000, immutable';
		if (req.headers['if-none-match'] === f.etag) {
			res.writeHead(304, { etag: f.etag, 'cache-control': cc });
			return void res.end();
		}
		res.writeHead(200, { 'content-type': f.type, etag: f.etag, 'cache-control': cc });
		res.end(f.body);
	};
	createServer((req, res) => {
		const run = () =>
			go(req, res).catch((error) => {
				console.error(error);
				res.writeHead(500);
				res.end(String(error));
			});
		if (options.rttMs) setTimeout(run, options.rttMs);
		else void run();
	}).listen(options.port, '127.0.0.1');
}

if (process.argv[1] && process.argv[1].endsWith('rapl-origin.ts')) {
	const env = process.env;
	const mirror = env.MIRROR ?? '/rig/mirror';
	if (env.MODE === 'views') {
		startViewsOrigin({
			mirror,
			rttMs: Number(env.RTT_MS ?? 40),
			optimized: 8931,
			shipping: 8932,
			stats: 8939
		});
	} else {
		startComputeOrigin({
			mirror,
			data: env.DATA ?? '/rig/data',
			port: Number(env.PORT ?? 8941),
			rttMs: Number(env.RTT_MS ?? 0),
			benchTerms: Number(env.BENCH_TERMS ?? 3),
			ollama: env.OLLAMA ?? 'http://host.docker.internal:11434',
			model: env.MODEL ?? 'llama3.1:8b'
		});
	}
	console.log('origin up', env.MODE ?? 'compute');
}
