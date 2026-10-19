import type { AssemblyBody } from './artifact.js';

const PLACEHOLDER = /<span data-spool-placeholder="([^"]*)"><\/span>/g;
const SLOT = /\{\{spool-slot:([A-Za-z0-9_.-]+)\}\}/g;

/** the markup a shell carries for a hole named `id`; `id` must not contain a double quote */
export function placeholder(id: string): string {
	return `<span data-spool-placeholder="${id}"></span>`;
}

/** the token a shell carries for a named value */
export function slot(name: string): string {
	return `{{spool-slot:${name}}}`;
}

/** every placeholder id in a shell, in document order */
export function placeholderIds(shell: string): string[] {
	return [...shell.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
}

/** every slot name in a shell, in document order */
export function slotNames(shell: string): string[] {
	return [...shell.matchAll(SLOT)].map((m) => m[1] as string);
}

/** what a fill produced and which names did not line up */
export type AssemblyResult = {
	html: string;
	filled: string[];
	/** names the shell has that nothing answered */
	unfilled: string[];
	/** names supplied that the shell does not have */
	unmatched: string[];
};

function fill(
	shell: string,
	pattern: RegExp,
	values: Readonly<Record<string, string>>
): AssemblyResult {
	const filled: string[] = [];
	const unfilled: string[] = [];
	const seen = new Set<string>();
	const html = shell.replace(pattern, (whole, id: string) => {
		seen.add(id);
		const value = Object.hasOwn(values, id) ? values[id] : undefined;
		if (value === undefined) {
			unfilled.push(id);
			return whole;
		}
		filled.push(id);
		return value;
	});
	const unmatched = Object.keys(values).filter((id) => !seen.has(id));
	return { html, filled, unfilled, unmatched };
}

/**
 * Fills a shell's placeholders with fragment markup by string replacement. An unfilled
 * placeholder stays in place: dropping it would hide a region the shell and fragments disagree
 * about.
 */
export function assemble(
	shell: string,
	fragments: Readonly<Record<string, string>>
): AssemblyResult {
	return fill(shell, PLACEHOLDER, fragments);
}

/** fills a shell's slot tokens with named values; same contract as {@link assemble} */
export function fillSlots(shell: string, values: Readonly<Record<string, string>>): AssemblyResult {
	return fill(shell, SLOT, values);
}

/** the full page for an assembly body, or the reason it cannot be built locally */
export function renderAssembly(
	body: AssemblyBody
): { ok: true; html: string } | { ok: false; reason: string } {
	const plain = (values: AssemblyBody['fragments']) => {
		const out: Record<string, string> = {};
		for (const [name, value] of Object.entries(values ?? {})) {
			if (typeof value !== 'string') return null;
			out[name] = value;
		}
		return out;
	};
	const fragmentText = plain(body.fragments);
	const slotText = plain(body.slots);
	if (!fragmentText || !slotText) return { ok: false, reason: 'unresolved reference' };
	const fragments = assemble(body.shell, fragmentText);
	if (fragments.unfilled.length > 0) {
		return { ok: false, reason: `unfilled placeholders: ${fragments.unfilled.join(', ')}` };
	}
	const slots = fillSlots(fragments.html, slotText);
	if (slots.unfilled.length > 0) {
		return { ok: false, reason: `unfilled slots: ${slots.unfilled.join(', ')}` };
	}
	return { ok: true, html: slots.html };
}
