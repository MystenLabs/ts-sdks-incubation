/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/
import { MoveStruct } from '../utils/index.ts';
import { bcs } from '@mysten/sui/bcs';
const $moduleName = '@local/demo-coins::dbtc';
export const DBTC = new MoveStruct({ name: `${$moduleName}::DBTC`, fields: {
        dummy_field: bcs.bool()
    } });