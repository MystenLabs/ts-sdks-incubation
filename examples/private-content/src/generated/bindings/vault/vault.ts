/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/
import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.ts';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction } from '@mysten/sui/transactions';
import * as table from './deps/sui/table.ts';
const $moduleName = '@local/vault::vault';
export const File = new MoveStruct({ name: `${$moduleName}::File`, fields: {
        id: bcs.Address,
        /**
         * Walrus blob id (32 raw bytes; URL-safe base64 in the Walrus HTTP API). The bytes
         * themselves live in the Walrus storage committee; authorized readers fetch via
         * `GET /v1/blobs/<base64-id>` and decrypt with Seal.
         */
        blob_id: bcs.vector(bcs.u8()),
        /**
         * IBE identity (uniformly random 32 bytes) the uploader chose at encrypt time.
         * Bound to this File on-chain so seal_approve can confirm the requested key id
         * matches the one used at encrypt time. Public — security comes from membership in
         * `authorized`.
         */
        seal_id: bcs.vector(bcs.u8()),
        owner: bcs.Address,
        name: bcs.string(),
        /**
         * Set of addresses allowed to decrypt this file. Modify via `grant`. Includes
         * `owner` from creation. (Allowlist pattern — matches
         * MystenLabs/seal/move/patterns/whitelist.move so the policy fn can use
         * shared-object-only inputs and ctx.sender(), which is what Seal's
         * onlyTransactionKind dry-run supports.)
         */
        authorized: table.Table
    } });
export const Cap = new MoveStruct({ name: `${$moduleName}::Cap`, fields: {
        id: bcs.Address,
        file_id: bcs.Address
    } });
export interface UploadArguments {
    name: RawTransactionArgument<string>;
    blobId: RawTransactionArgument<Array<number>>;
    sealId: RawTransactionArgument<Array<number>>;
}
export interface UploadOptions {
    package?: string;
    arguments: UploadArguments | [
        name: RawTransactionArgument<string>,
        blobId: RawTransactionArgument<Array<number>>,
        sealId: RawTransactionArgument<Array<number>>
    ];
}
/**
 * Upload a new encrypted file. Caller becomes the owner, gets added to the
 * `authorized` set, and receives a Cap.
 */
export function upload(options: UploadOptions) {
    const packageAddress = options.package ?? '@local/vault';
    const argumentsTypes = [
        '0x1::string::String',
        'vector<u8>',
        'vector<u8>'
    ] satisfies (string | null)[];
    const parameterNames = ["name", "blobId", "sealId"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'vault',
        function: 'upload',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface UploadEntryArguments {
    name: RawTransactionArgument<string>;
    blobId: RawTransactionArgument<Array<number>>;
    sealId: RawTransactionArgument<Array<number>>;
}
export interface UploadEntryOptions {
    package?: string;
    arguments: UploadEntryArguments | [
        name: RawTransactionArgument<string>,
        blobId: RawTransactionArgument<Array<number>>,
        sealId: RawTransactionArgument<Array<number>>
    ];
}
export function uploadEntry(options: UploadEntryOptions) {
    const packageAddress = options.package ?? '@local/vault';
    const argumentsTypes = [
        '0x1::string::String',
        'vector<u8>',
        'vector<u8>'
    ] satisfies (string | null)[];
    const parameterNames = ["name", "blobId", "sealId"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'vault',
        function: 'upload_entry',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GrantArguments {
    file: RawTransactionArgument<string>;
    recipient: RawTransactionArgument<string>;
}
export interface GrantOptions {
    package?: string;
    arguments: GrantArguments | [
        file: RawTransactionArgument<string>,
        recipient: RawTransactionArgument<string>
    ];
}
/**
 * Owner adds `recipient` to the authorized set and transfers them a Cap as a UI
 * hint. Granting twice is a no-op on the table.
 */
export function grant(options: GrantOptions) {
    const packageAddress = options.package ?? '@local/vault';
    const argumentsTypes = [
        null,
        'address'
    ] satisfies (string | null)[];
    const parameterNames = ["file", "recipient"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'vault',
        function: 'grant',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface GrantEntryArguments {
    file: RawTransactionArgument<string>;
    recipient: RawTransactionArgument<string>;
}
export interface GrantEntryOptions {
    package?: string;
    arguments: GrantEntryArguments | [
        file: RawTransactionArgument<string>,
        recipient: RawTransactionArgument<string>
    ];
}
export function grantEntry(options: GrantEntryOptions) {
    const packageAddress = options.package ?? '@local/vault';
    const argumentsTypes = [
        null,
        'address'
    ] satisfies (string | null)[];
    const parameterNames = ["file", "recipient"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'vault',
        function: 'grant_entry',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface SealApproveArguments {
    id: RawTransactionArgument<Array<number>>;
    file: RawTransactionArgument<string>;
}
export interface SealApproveOptions {
    package?: string;
    arguments: SealApproveArguments | [
        id: RawTransactionArgument<Array<number>>,
        file: RawTransactionArgument<string>
    ];
}
/**
 * Seal policy gate. The key server constructs a dry-run tx with the requester
 * (from the signed certificate) as ctx.sender, this `file` (shared, freely
 * passable), and the requested key id. We assert the caller is in the authorized
 * set and that the id matches the one bound at upload time.
 */
export function sealApprove(options: SealApproveOptions) {
    const packageAddress = options.package ?? '@local/vault';
    const argumentsTypes = [
        'vector<u8>',
        null
    ] satisfies (string | null)[];
    const parameterNames = ["id", "file"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'vault',
        function: 'seal_approve',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}