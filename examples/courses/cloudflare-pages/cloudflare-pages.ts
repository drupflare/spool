import { courseSpool } from '../shared/site.ts';

// workerd refuses I/O in global scope, so the pack is built on the first request
let site: ReturnType<typeof courseSpool> | undefined;

export const onRequest = async (context: { request: Request; next(): Promise<Response> }) => {
	site ??= courseSpool();
	const { spool } = await site;
	return spool.handle(context.request, () => context.next());
};
