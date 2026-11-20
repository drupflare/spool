import { createSpool } from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';

export const spool = createSpool({ routes: [], store: memoryStore() });
