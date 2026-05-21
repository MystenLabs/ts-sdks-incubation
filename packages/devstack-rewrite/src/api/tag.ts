// Tag/provide re-export. Tags are constructed once at the plugin
// barrel; not passed as runtime data (see substrate/tag.ts header).

export {
	defineTag,
	type AnyTag,
	type ResolvedOf,
	type Tag,
	type TagIdOf,
} from '../substrate/tag.ts';
