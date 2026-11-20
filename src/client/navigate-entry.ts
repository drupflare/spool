import { enableNavigation } from './navigate.js';

(globalThis as { spoolNavigate?: { enableNavigation: typeof enableNavigation } }).spoolNavigate = {
	enableNavigation
};
