/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/
import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.ts';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction } from '@mysten/sui/transactions';
const $moduleName = '@local/connect-four::game';
export const Lobby = new MoveStruct({ name: `${$moduleName}::Lobby`, fields: {
        id: bcs.Address,
        creator: bcs.Address
    } });
export const Game = new MoveStruct({ name: `${$moduleName}::Game`, fields: {
        id: bcs.Address,
        board: bcs.vector(bcs.vector(bcs.u8())),
        player_a: bcs.Address,
        player_b: bcs.Address,
        turn: bcs.Address,
        moves: bcs.u8(),
        winner: bcs.option(bcs.Address)
    } });
export interface CreateLobbyOptions {
    package?: string;
    arguments?: [
    ];
}
export function createLobby(options: CreateLobbyOptions = {}) {
    const packageAddress = options.package ?? '@local/connect-four';
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'game',
        function: 'create_lobby',
    });
}
export interface JoinLobbyArguments {
    lobby: RawTransactionArgument<string>;
}
export interface JoinLobbyOptions {
    package?: string;
    arguments: JoinLobbyArguments | [
        lobby: RawTransactionArgument<string>
    ];
}
export function joinLobby(options: JoinLobbyOptions) {
    const packageAddress = options.package ?? '@local/connect-four';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["lobby"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'game',
        function: 'join_lobby',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface PlayArguments {
    game: RawTransactionArgument<string>;
    column: RawTransactionArgument<number>;
}
export interface PlayOptions {
    package?: string;
    arguments: PlayArguments | [
        game: RawTransactionArgument<string>,
        column: RawTransactionArgument<number>
    ];
}
export function play(options: PlayOptions) {
    const packageAddress = options.package ?? '@local/connect-four';
    const argumentsTypes = [
        null,
        'u8'
    ] satisfies (string | null)[];
    const parameterNames = ["game", "column"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'game',
        function: 'play',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}