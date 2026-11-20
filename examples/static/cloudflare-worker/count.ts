import { staticSite } from '../shared/site.ts';

type Env = { MODE?: string; LEASE?: string };

// the measurement entry: it counts each invocation, marks each response it produced with the
// running count, and answers `/__count` and `/__add` for the rig. A response without the mark came
// from the assets. MODE=none serves the origin page with no spool; LEASE is the stub lease in seconds.
// `isolate` names the running copy, so the rig can tell that a reload started a new one
let invocations = 0;
let isolate: string | undefined;
let site: ReturnType<typeof staticSite> | undefined;

export default {
	async fetch(request: Request, env: Env = {}): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === '/__count') {
			isolate ??= crypto.randomUUID();
			return Response.json({ invocations, isolate });
		}
		site ??= staticSite({ lease: Number(env.LEASE ?? 86_400) });
		const { spool, page, addEntry } = await site;
		if (pathname === '/__add' && request.method === 'POST') {
			await addEntry(await request.json());
			return Response.json({ added: true });
		}
		invocations += 1;
		const answer =
			env.MODE === 'none' ? await page(request) : await spool.handle(request, page);
		const marked = new Response(answer.body, answer);
		marked.headers.set('x-worker-invoked', String(invocations));
		return marked;
	}
};
