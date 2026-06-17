/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/
import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.ts';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction } from '@mysten/sui/transactions';
const $moduleName = '@local/counter::counter';
export const Counter = new MoveStruct({ name: `${$moduleName}::Counter`, fields: {
        id: bcs.Address,
        owner: bcs.Address,
        value: bcs.u64()
    } });
export interface CreateAndShareOptions {
    package?: string;
    arguments?: [
    ];
}
/**
 * Create a shared `Counter` owned (by record) by the caller, starting at zero.
 * Shared so any account can increment it without a transfer.
 */
export function createAndShare(options: CreateAndShareOptions = {}) {
    const packageAddress = options.package ?? '@local/counter';
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'counter',
        function: 'create_and_share',
    });
}
export interface IncrementEntryArguments {
    counter: RawTransactionArgument<string>;
}
export interface IncrementEntryOptions {
    package?: string;
    arguments: IncrementEntryArguments | [
        counter: RawTransactionArgument<string>
    ];
}
/** Increment the counter by one. Entry so clients can call it directly. */
export function incrementEntry(options: IncrementEntryOptions) {
    const packageAddress = options.package ?? '@local/counter';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["counter"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'counter',
        function: 'increment_entry',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ValueArguments {
    counter: RawTransactionArgument<string>;
}
export interface ValueOptions {
    package?: string;
    arguments: ValueArguments | [
        counter: RawTransactionArgument<string>
    ];
}
/** Read the current value. */
export function value(options: ValueOptions) {
    const packageAddress = options.package ?? '@local/counter';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["counter"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'counter',
        function: 'value',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}