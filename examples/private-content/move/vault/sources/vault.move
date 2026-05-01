module vault::vault;

use std::string::String;
use sui::table;

const ENoAccess: u64 = 1;
const ENotOwner: u64 = 2;
const EWrongSealId: u64 = 3;

/// Encrypted blob registered with the local Seal key server. Shared so any
/// authorized address can read its `encrypted` bytes and decrypt them via
/// Seal.
///
/// FRICTION: storing ciphertext directly on-chain caps file size at the
/// Sui object limit (~256 KiB). A future revision will swap `encrypted`
/// for a Walrus blob id once the publisher/aggregator are wired into the
/// devstack; the access shape stays the same.
public struct File has key {
	id: UID,
	/// AES-GCM ciphertext + Seal envelope (BCS of `EncryptedObject`).
	/// Public to anyone, decryptable only by `authorized` set members.
	encrypted: vector<u8>,
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
	encrypted: vector<u8>,
	seal_id: vector<u8>,
	ctx: &mut TxContext,
): Cap {
	let mut authorized = table::new(ctx);
	table::add(&mut authorized, ctx.sender(), true);
	let file = File {
		id: object::new(ctx),
		encrypted,
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
	encrypted: vector<u8>,
	seal_id: vector<u8>,
	ctx: &mut TxContext,
) {
	let cap = upload(name, encrypted, seal_id, ctx);
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
