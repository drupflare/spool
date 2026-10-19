/** why a protocol value was refused */
export type ProtocolErrorCode =
	| 'bad-pattern'
	| 'bad-route'
	| 'bad-header'
	| 'bad-artifact'
	| 'bad-sync'
	| 'bad-beacon'
	| 'bad-template'
	| 'bad-manifest';

/** thrown for malformed protocol input; `code` names the family so callers can map it to a status */
export class ProtocolError extends Error {
	readonly code: ProtocolErrorCode;

	constructor(code: ProtocolErrorCode, message: string) {
		super(message);
		this.name = 'ProtocolError';
		this.code = code;
	}
}
