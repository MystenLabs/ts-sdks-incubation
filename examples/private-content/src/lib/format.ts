export function shortAddress(address: string, head = 6, tail = 4): string {
	if (address.length <= head + tail + 2) return address;
	return `${address.slice(0, head + 2)}…${address.slice(-tail)}`;
}

type AccountAddressRecord = Record<string, string | { readonly address: string }>;

export function labelFor(address: string, accounts: AccountAddressRecord): string | null {
	for (const [name, account] of Object.entries(accounts)) {
		const accountAddress = typeof account === 'string' ? account : account.address;
		if (accountAddress === address) return name;
	}
	return null;
}

export function bytesToString(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

export function stringToBytes(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

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

export function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
