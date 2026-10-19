import { spool } from './spool';

export const onRequest = (context: { request: Request; next(): Promise<Response> }) =>
	spool.handle(context.request, () => context.next());
