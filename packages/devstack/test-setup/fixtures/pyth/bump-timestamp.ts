// Bump-timestamp wrapper for the captured Pyth API fixtures. Each call
// reads the fixture, mutates `parsed[].price.publish_time` and
// `parsed[].ema_price.publish_time` by `+secOffset`, and returns the
// shape the pusher's `fetchBenchmarks` consumer expects.
//
// Used by L3 docker tests for the pusher: they pin the on-chain feed at
// a known price, then assert `priceInfo.timestamp` advances by repeated
// pusher ticks. Without the bump, every tick writes the same timestamp
// and the assertion can't distinguish "pusher ticked" from "nothing
// happened".

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { PythPriceUpdate } from '../../../src/services/pyth/pusher.js';

interface FixtureBody {
	readonly parsed: ReadonlyArray<{
		readonly id: string;
		readonly price: {
			readonly price: string;
			readonly expo: number;
			readonly publish_time: number;
			readonly conf: string;
		};
		readonly ema_price: {
			readonly price: string;
			readonly expo: number;
			readonly publish_time: number;
			readonly conf: string;
		};
	}>;
}

const FIXTURE_DIR = path.join(__dirname);

const loadFixture = (label: 'sui' | 'deep' | 'usdc'): FixtureBody =>
	JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${label}.json`), 'utf8')) as FixtureBody;

/**
 * Compose a deterministic Pyth update stream from the captured fixtures.
 * `secOffset` is added to each fixture's `publish_time` so the on-chain
 * `PriceInfoObject.timestamp` advances each call. Returns the shape the
 * pusher's `source: { kind: 'fixture' }` expects.
 */
export const bumpedFixtureUpdates = (
	labels: ReadonlyArray<'sui' | 'deep' | 'usdc'>,
	secOffset: number,
): ReadonlyArray<PythPriceUpdate> => {
	const out: Array<PythPriceUpdate> = [];
	for (const label of labels) {
		const fixture = loadFixture(label);
		for (const p of fixture.parsed) {
			const priceMag = BigInt(p.price.price);
			const emaMag = BigInt(p.ema_price.price.replace('-', ''));
			const expoNum = Number(p.price.expo);
			out.push({
				feedId: '0x' + p.id,
				priceMagnitude: priceMag < 0n ? -priceMag : priceMag,
				priceNegative: priceMag < 0n,
				expoMagnitude: BigInt(Math.abs(expoNum)),
				expoNegative: expoNum < 0,
				publishTime: BigInt(p.price.publish_time + secOffset),
				emaPriceMagnitude: emaMag,
				emaPriceNegative: p.ema_price.price.startsWith('-'),
				conf: BigInt(p.price.conf),
				emaConf: BigInt(p.ema_price.conf),
			});
		}
	}
	return out;
};
