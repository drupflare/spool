import { escapeHtml } from '../../../src/protocol/index';
import { serve } from '../../../src/sw/index';

declare const CONFIG: string;

serve(JSON.parse(CONFIG), {
	'/rosters/:id': (artifact) => {
		const { names } = (artifact.body as { data: { names: string[] } }).data;
		return `<!doctype html><html><head><title>Roster</title></head><body><ul>${names.map((name) => `<li>${escapeHtml(name)}</li>`).join('')}</ul></body></html>`;
	}
});
