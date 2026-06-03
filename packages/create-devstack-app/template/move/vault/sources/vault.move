module vault::vault;

use std::string::String;
use sui::table;

const ENoAccess: u64 = 1;
const ENotOwner: u64 = 2;
const EWrongSealId: u64 = 3;

/// Encrypted blob registered with the local Seal key server. The actual
/// ciphertext lives on Walrus; on-chain we store only the blob id (32
/// bytes) plus the access list. Shared so any authorized address can
/// fetch the blob from a Walrus aggregator and decrypt it via Seal.
public struct File has key {
	id: UID,
	/// Walrus blob id (32 raw bytes; URL-safe base64 in the Walrus HTTP
	/// API). The bytes themselves live in the Walrus storage committee;
	/// authorized readers fetch via `GET /v1/blobs/<base64-id>` and
	/// decrypt with Seal.
	blob_id: vector<u8>,
	/// IBE identity (uniformly random 32 bytes) the uploader chose at
	/// encrypt time. Bound to this File on-chain so seal_approve can
	/// confirm the requested key id matches the one used at encrypt
	/// time. Public — security comes from membership in `authorized`.
	seal_id: vector<u8>,
	owner: address,
	name: String,
	/// Set of addresses allowed to decrypt this file. Modify via
	/// `grant`. Includes `owner` from creation. (Allowlist pattern —
	/// matches MystenLabs/seal/move/patterns/whitelist.move so the
	/// policy fn can use shared-object-only inputs and ctx.sender(),
	/// which is what Seal's onlyTransactionKind dry-run supports.)
	authorized: table::Table<address, bool>,
}

/// Owned, transferable hint object: holding a Cap means the holder is
/// (currently) listed in the corresponding `File.authorized` set, which
/// makes UI iteration cheap (`listOwnedObjects<Cap>`) without scanning
/// every shared File. The actual access check uses `authorized`, not
/// the Cap — sharing a Cap to someone outside the set won't grant
/// decrypt access.
public struct Cap has key, store {
	id: UID,
	file_id: ID,
}

/// Upload a new encrypted file. Caller becomes the owner, gets added
/// to the `authorized` set, and receives a Cap.
public fun upload(
	name: String,
	blob_id: vector<u8>,
	seal_id: vector<u8>,
	ctx: &mut TxContext,
): Cap {
	let mut authorized = table::new(ctx);
	table::add(&mut authorized, ctx.sender(), true);
	let file = File {
		id: object::new(ctx),
		blob_id,
		seal_id,
		owner: ctx.sender(),
		name,
		authorized,
	};
	let cap = Cap { id: object::new(ctx), file_id: object::id(&file) };
	transfer::share_object(file);
	cap
}

entry fun upload_entry(
	name: String,
	blob_id: vector<u8>,
	seal_id: vector<u8>,
	ctx: &mut TxContext,
) {
	let cap = upload(name, blob_id, seal_id, ctx);
	transfer::public_transfer(cap, ctx.sender());
}

/// Owner adds `recipient` to the authorized set and transfers them a
/// Cap as a UI hint. Granting twice is a no-op on the table.
public fun grant(file: &mut File, recipient: address, ctx: &mut TxContext) {
	assert!(file.owner == ctx.sender(), ENotOwner);
	if (!table::contains(&file.authorized, recipient)) {
		table::add(&mut file.authorized, recipient, true);
	};
	let cap = Cap { id: object::new(ctx), file_id: object::id(file) };
	transfer::public_transfer(cap, recipient);
}

entry fun grant_entry(file: &mut File, recipient: address, ctx: &mut TxContext) {
	grant(file, recipient, ctx);
}

/// Seal policy gate. The key server constructs a dry-run tx with the
/// requester (from the signed certificate) as ctx.sender, this `file`
/// (shared, freely passable), and the requested key id. We assert the
/// caller is in the authorized set and that the id matches the one
/// bound at upload time.
entry fun seal_approve(id: vector<u8>, file: &File, ctx: &TxContext) {
	assert!(table::contains(&file.authorized, ctx.sender()), ENoAccess);
	assert!(id == file.seal_id, EWrongSealId);
}
