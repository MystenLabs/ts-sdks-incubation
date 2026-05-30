// Scoped seq-tagged multimap primitive — barrel.
//
// The shared storage layer behind the substrate's scope-bound
// registries (strategy / formatter / capability-sinks): a per-key list
// of seq-tagged entries whose finalizers drop only what they added.
// Winner policy stays at each call site; this exposes the snapshot.

export {
	makeScopedMultimap,
	type MultimapEntry,
	type MultimapItem,
	type ScopedMultimap,
} from './service.ts';
