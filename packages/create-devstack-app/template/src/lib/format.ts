// Small byte/hex helpers used by the seal panel (IBE identity encoding).

export function bytesToHex(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i++) {
		s += (bytes[i] ?? 0).toString(16).padStart(2, '0');
	}
	return s;
}

export function hexToBytes(hex: string): Uint8Array {
	const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
	if (clean.length % 2 !== 0) throw new Error(`hex string has odd length: ${clean.length}`);
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}
