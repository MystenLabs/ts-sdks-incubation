// Lease-broker runtime — barrel.
//
// L0 substrate service. Generic per-key serialization primitive:
// callers that need at-most-one-in-flight on an opaque resource
// (per-address sequence number, per-connection gate, per-slot work
// queue, ...) yield `LeaseBrokerService` and call `acquire(key,
// owner)`. Lease lifetime is scope-bound — there is no explicit
// release.

export {
	LeaseBrokerService,
	layerLeaseBroker,
	leaseKey,
	type Lease,
	type LeaseBroker,
	type LeaseKey,
	type Owner,
} from './service.ts';
