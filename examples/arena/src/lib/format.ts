// FRICTION: fourth copy. Extract to a shared @mysten-incubation/ui-utils.
export function shortAddress(address: string, head = 6, tail = 4): string {
	if (address.length <= head + tail + 2) return address;
	return `${address.slice(0, head + 2)}…${address.slice(-tail)}`;
}

export function labelFor(address: string, accounts: Record<string, string>): string | null {
	for (const [name, addr] of Object.entries(accounts)) {
		if (addr === address) return name;
	}
	return null;
}
