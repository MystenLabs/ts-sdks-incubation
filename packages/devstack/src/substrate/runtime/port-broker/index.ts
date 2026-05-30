// Port-broker runtime — barrel.
//
// L0 substrate service. Plugins that need a host port yield
// `PortBrokerService` and call `allocate({ preferredPort?, windowHint?,
// owner?, probeHost? })`. One broker instance per stack (Layer-driven),
// tracking in-process allocations in a `Ref<Map>` and verifying kernel
// availability via a transient `net.Server` bind probe.

export {
	DEFAULT_PORT_WINDOW,
	PortBrokerService,
	layerPortBroker,
	type AllocateOptions,
	type AllocatedPort,
	type PortAllocationWindow,
	type PortBroker,
	type PortProbeHost,
} from './service.ts';
// `PortBrokerError` lives next to the other per-subsystem tagged errors
// in `runtime/errors.ts`; re-exported here so consumers can pull
// everything from this barrel.
export { PortBrokerError } from '../errors.ts';
