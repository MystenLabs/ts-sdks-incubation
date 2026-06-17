/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/
import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.ts';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction } from '@mysten/sui/transactions';
const $moduleName = '@local/greeting::board';
export const Board = new MoveStruct({ name: `${$moduleName}::Board`, fields: {
        id: bcs.Address,
        message_count: bcs.u64()
    } });
export const Greeting = new MoveStruct({ name: `${$moduleName}::Greeting`, fields: {
        sender: bcs.Address,
        message: bcs.vector(bcs.u8()),
        count: bcs.u64()
    } });
export interface GreetArguments {
    board: RawTransactionArgument<string>;
    message: RawTransactionArgument<Array<number>>;
}
export interface GreetOptions {
    package?: string;
    arguments: GreetArguments | [
        board: RawTransactionArgument<string>,
        message: RawTransactionArgument<Array<number>>
    ];
}
export function greet(options: GreetOptions) {
    const packageAddress = options.package ?? '@local/greeting';
    const argumentsTypes = [
        null,
        'vector<u8>'
    ] satisfies (string | null)[];
    const parameterNames = ["board", "message"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'board',
        function: 'greet',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}