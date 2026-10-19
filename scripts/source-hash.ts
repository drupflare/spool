import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOTS = ['src/protocol', 'src/sw', 'src/client'];

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.flatMap((entry) => {
			const path = join(dir, entry.name);
			return entry.isDirectory() ? walk(path) : [path];
		})
		.filter((path) => path.endsWith('.ts'))
		.sort();
}

/** a hash of every source file the embedded worker and client bundles are built from */
export function sourceHash(root: string): string {
	const hash = createHash('sha256');
	for (const dir of ROOTS) {
		for (const path of walk(join(root, dir))) {
			hash.update(`${relative(root, path).split(sep).join('/')}\u0000`);
			hash.update(readFileSync(path));
			hash.update('\u0000');
		}
	}
	return hash.digest('hex');
}
