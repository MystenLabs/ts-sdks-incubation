// Subnet-prefix derivation — ONE canonical implementation.
//
// Architecture § "What's collapsed" — multiple plugins (walrus, seal)
// need a deterministic Docker `/24` subnet keyed off their stack
// identity so parallel local stacks don't all collide on Docker's
// default IPAM pool. Each plugin previously inlined the same FNV-1a
// hash → IPv4 third-octet derivation; the only thing that varied was
// the second-octet base offset (walrus uses `64`, seal uses `128`)
// so they live in disjoint 64-wide bands inside `10.0.0.0/8`.
//
// Algorithm (DO NOT CHANGE without re-coordinating with every caller —
// changing it shifts every parallel stack's assigned subnet, which
// silently invalidates running containers and on-disk snapshots that
// reference IPs by literal):
//
//   1. FNV-1a/32 over the UTF-16 code-unit sequence of `input`,
//      seeded `0x811c9dc5`, prime `0x01000193`, kept in unsigned
//      32-bit space via `>>> 0`.
//   2. Take the low `64 * 256 = 16384` buckets of the hash.
//   3. Split the bucket into a second-octet add (`bucket / 256`,
//      0..63) and a third-octet (`bucket % 256`, 0..255).
//   4. Emit `'10.<secondOctetOffset + add>.<third>'`.
//
// The returned prefix is the `a.b.c` of an IPv4 `/24` — callers
// append `.0/24` for the subnet and `.1` for the gateway.

/**
 * Derive a deterministic `/24` IPv4 subnet prefix from an identity
 * string, suitable for `EnsureNetworkSpec.subnet` requests.
 *
 * Uses FNV-1a/32 to bucket the input into one of 16384 slots inside
 * a 64-wide band of `10.0.0.0/8`. `secondOctetOffset` selects the
 * band — pick a value disjoint from every other caller (current
 * users: walrus `64`, seal `128`).
 *
 * @param input - opaque identity string. Callers should pack their
 *   stack-identifying fields with a separator that cannot appear in
 *   any field (`\0` is the convention).
 * @param secondOctetOffset - lower-bound of the second IPv4 octet.
 *   The derived second octet falls in `[offset, offset + 63]`.
 * @returns prefix string `'10.b.c'`. Append `.0/24` for the subnet
 *   and `.1` for the gateway.
 */
export const deriveSubnetPrefix = (input: string, secondOctetOffset: number): string => {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	const bucket = hash % (64 * 256);
	const secondOctet = secondOctetOffset + Math.floor(bucket / 256);
	const thirdOctet = bucket % 256;
	return `10.${secondOctet}.${thirdOctet}`;
};

/**
 * Expand a `/24` prefix into the `{ subnet, gateway }` shape the
 * container-runtime `EnsureNetworkSpec` consumes.
 *
 * Convention: `<prefix>.0/24` for the subnet, `<prefix>.1` for the
 * gateway — the same pair walrus and seal both stamp on their
 * `ensureNetwork` requests. Folded here so the `/24` + `.1` literals
 * live in ONE place.
 */
export const subnetSpec = (
	prefix: string,
): { readonly subnet: string; readonly gateway: string } => ({
	subnet: `${prefix}.0/24`,
	gateway: `${prefix}.1`,
});
