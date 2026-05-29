// `PanelHeader` is the formalized name for the panel header pattern in the
// design handoff, which aliases the existing `SectionHead` (title + count +
// right-aligned actions). Re-export rather than duplicate its markup.

export {
	SectionHead as PanelHeader,
	type SectionHeadProps as PanelHeaderProps,
} from './SectionHead.tsx';
