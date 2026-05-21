// Port-broker runtime — barrel.
//
// L0 substrate service. Plugins that need a host port yield
// `PortBrokerService` and call `allocate({ kind, preferredPort? })`.
// One broker instance per stack (Layer-driven), tracking in-process
// allocations in a `Ref<Map>` and verifying kernel availability via a
// transient `net.Server` bind probe.

export {
	PortBrokerService,
	layerPortBroker,
	type AllocateOptions,
	type AllocatedPort,
	type PortBroker,
	type PortKind,
	type PortProbeHost,
} from './service.ts';
// `PortBrokerError` lives next to the other per-subsystem tagged errors
// in `runtime/errors.ts`; re-exported here so consumers can pull
// everything from this barrel.
export { PortBrokerError } from '../errors.ts';
