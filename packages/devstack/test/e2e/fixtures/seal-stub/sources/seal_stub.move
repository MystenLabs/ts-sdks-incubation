// Seal e2e stub — marker module for the local test package.
//
// Stand-in for the real seal contracts under `move/seal/` in
// `MystenLabs/seal`. The register path exercised by e2e lives in
// `key_server.move`; this module remains as a tiny extra symbol for
// ad-hoc smoke checks of the stub package.

module seal_stub::seal_stub;

public struct Marker has copy, drop {
	tag: vector<u8>,
}

/// No-op constructor — kept so the module surfaces a public function
/// to keep the Move compiler happy across edition bumps.
public fun marker(tag: vector<u8>): Marker {
	Marker { tag }
}
