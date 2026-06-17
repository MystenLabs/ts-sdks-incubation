/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/
import { MoveStruct } from '../utils/index.ts';
import { bcs } from '@mysten/sui/bcs';
const $moduleName = '@local/demo-coins::deth';
export const DETH = new MoveStruct({ name: `${$moduleName}::DETH`, fields: {
        dummy_field: bcs.bool()
    } });