// Lease-broker Layer factory.
//
// Single in-process Layer today. The broker's state lives in the
// `Layer.effect` closure; closing the Layer's scope drops every
// active entry. Parallel stacks each get their own broker — the
// broker is name-blind and stack-local by Layer construction.

export { layerLeaseBroker } from './service.ts';
