/** base64url SHA-256 of the UTF-8 bytes of `text`, without padding */
export async function shellHash(text: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	);
	let binary = '';
	for (const byte of digest) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
