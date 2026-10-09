// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { MultiStoreController } from '@nanostores/lit';
import type { ReactiveElement } from 'lit';
import type { CctpKit } from '../core/index.js';

type ValueOf<T> = T[keyof T];
type StoreValues = ValueOf<CctpKit['stores']>[];

/**
 * Property decorator that binds a Lit element to a `CctpKit` instance: whenever any of the
 * kit's stores change, the element re-renders. Swapping the instance disconnects the old
 * controller and attaches a new one. Mirrors dapp-kit's internal `storeProperty`.
 */
export function storeProperty() {
	return function (target: any, propertyKey: PropertyKey) {
		const controllerKey = Symbol();
		const valueKey = Symbol();

		interface Target extends ReactiveElement {
			[controllerKey]: MultiStoreController<StoreValues> | undefined;
			[valueKey]: CctpKit | undefined;
		}

		Object.defineProperty(target, propertyKey, {
			get(this: Target): CctpKit | undefined {
				return this[valueKey];
			},
			set(this: Target, newInstance: CctpKit | undefined) {
				const oldInstance = this[valueKey];
				if (oldInstance === newInstance) return;
				this[valueKey] = newInstance;

				const existing = this[controllerKey];
				if (existing) {
					existing.hostDisconnected();
					this.removeController(existing);
				}

				const next = newInstance
					? new MultiStoreController(this, Object.values(newInstance.stores) as StoreValues)
					: undefined;
				this[controllerKey] = next;

				if (existing && !next) {
					this.requestUpdate(propertyKey, oldInstance);
				}
			},
			configurable: true,
			enumerable: true,
		});
	};
}
