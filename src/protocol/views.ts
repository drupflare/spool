/**
 * The view times a page keeps for the lease window, as the comma-separated text `spool:stamps` holds:
 * the stored ones a lease period still covers, then `now`, the last three. A stamp at or after `now`,
 * a full lease old, zero or not a number is outside. Not re-exported from the protocol index.
 */
export function viewStamps(stored: string, now: number, leaseMs: number): number[] {
	return [
		...stored
			.split(',')
			.filter(Boolean)
			.map(Number)
			.filter((t) => t >= 0 && t <= now && now - t < leaseMs),
		now
	].slice(-3);
}
