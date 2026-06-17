/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/
import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.ts';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction } from '@mysten/sui/transactions';
const $moduleName = '@local/managed-coin::managed_coin';
export const MANAGED_COIN = new MoveStruct({ name: `${$moduleName}::MANAGED_COIN`, fields: {
        dummy_field: bcs.bool()
    } });
export interface MintArguments {
    treasury: RawTransactionArgument<string>;
    amount: RawTransactionArgument<number | bigint>;
    recipient: RawTransactionArgument<string>;
}
export interface MintOptions {
    package?: string;
    arguments: MintArguments | [
        treasury: RawTransactionArgument<string>,
        amount: RawTransactionArgument<number | bigint>,
        recipient: RawTransactionArgument<string>
    ];
}
/** Mint `amount` to `recipient`. Caller must hold the TreasuryCap. */
export function mint(options: MintOptions) {
    const packageAddress = options.package ?? '@local/managed-coin';
    const argumentsTypes = [
        null,
        'u64',
        'address'
    ] satisfies (string | null)[];
    const parameterNames = ["treasury", "amount", "recipient"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'managed_coin',
        function: 'mint',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}