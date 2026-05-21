// Walrus e2e stub — minimal Move module so the package compiles.
//
// Stand-in for the real walrus contracts under `contracts/walrus/`
// in `MystenLabs/walrus`. The current local-cluster boot path never
// compiles this directly (the deploy one-shot uses the binary baked
// into the cargo image); we ship a real module so `sui move build`
// in any future ad-hoc smoke check succeeds.

module walrus_stub::walrus_stub;

public struct Marker has copy, drop {
	tag: vector<u8>,
}

/// No-op constructor — kept so the module surfaces a public function
/// to keep the Move compiler happy across edition bumps.
public fun marker(tag: vector<u8>): Marker {
	Marker { tag }
}
