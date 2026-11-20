declare module 'react-router' {
	export function createRequestHandler(
		build: unknown,
		mode?: string
	): (request: Request) => Promise<Response>;
}
