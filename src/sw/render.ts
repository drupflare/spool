import type { Artifact } from '../protocol/artifact.js';
import { renderAssembly } from '../protocol/assembly.js';
import type { SwConfig } from '../protocol/config.js';
import { shapeQuery } from '../protocol/query.js';
import type { SerializedRoute } from '../protocol/route.js';
import { injectClientTag } from '../protocol/tag.js';
import { interpretTemplate } from '../protocol/template/interpret.js';

/** a custom renderer for one route pattern; it replaces the built-in one for that route */
export type Renderer = (artifact: Artifact) => string | Promise<string>;

/** renderers keyed by route pattern */
export type Renderers = Record<string, Renderer>;

/** the page for an artifact, or the reason it cannot be built here and the network must answer */
export type Rendered = { ok: true; html: string } | { ok: false; reason: string };

/**
 * Builds the HTML for a stored artifact, or the JSON text of a `data` one. The result carries the same client tag the server
 * injects, so it equals the network render after normalisation. Any failure (a missing template,
 * an unfilled placeholder, a renderer that throws) is a refusal, never a partial page.
 * With `search` and a route that declares `query`, the template or renderer gets the page's
 * items in place of the collection, after the dataset proof checks out.
 */
export async function renderLocal(
	config: SwConfig,
	route: SerializedRoute,
	source: Artifact,
	renderers: Renderers = {},
	search?: string
): Promise<Rendered> {
	try {
		let artifact = source;
		if (search !== undefined && search !== '' && route.query) {
			if (source.strategy === 'assembly' || source.strategy === 'static') {
				return { ok: false, reason: `${source.strategy} artifact cannot answer a query` };
			}
			const shaped = await shapeQuery(route.query, source.body.data, search);
			if (!shaped.ok) return shaped;
			artifact = { ...source, body: { data: shaped.data } };
		}
		const custom = Object.hasOwn(renderers, route.pattern)
			? renderers[route.pattern]
			: undefined;
		let html: string;
		if (custom) html = await custom(artifact);
		else if (artifact.strategy === 'data' && route.strategy === 'data') {
			return { ok: true, html: JSON.stringify(artifact.body.data) };
		} else if (artifact.strategy === 'projection' && route.strategy === 'projection') {
			return { ok: false, reason: `no renderer for ${route.pattern}` };
		} else if (artifact.strategy === 'static' || artifact.strategy !== route.strategy) {
			return {
				ok: false,
				reason: `artifact is ${artifact.strategy}, route is ${route.strategy}`
			};
		} else if (artifact.strategy === 'assembly') {
			const result = renderAssembly(artifact.body);
			if (!result.ok) return result;
			html = result.html;
		} else if (artifact.strategy !== 'template') {
			return { ok: false, reason: `${artifact.strategy} has no built-in render` };
		} else {
			const template = Object.hasOwn(config.templates, route.pattern)
				? config.templates[route.pattern]
				: undefined;
			if (!template) return { ok: false, reason: `no template for ${route.pattern}` };
			html = interpretTemplate(template, artifact.body.data);
		}
		if (route.strategy === 'data') return { ok: true, html };
		return { ok: true, html: injectClientTag(html, config.clientTag) };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : 'render failed' };
	}
}
