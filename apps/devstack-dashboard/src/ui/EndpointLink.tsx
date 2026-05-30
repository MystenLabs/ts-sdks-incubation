import type { MouseEvent } from 'react';
import type { Endpoint } from '../lib/types.ts';
import { Dot } from './Dot.tsx';
import { Icon } from './icons.tsx';

export interface EndpointLinkProps {
	/** The endpoint to link to; `name` labels it, `url` is the href/title. */
	readonly endpoint: Endpoint;
}

/**
 * Inline chip linking to a service endpoint, with a cyan status dot and an
 * external-link glyph that surfaces on hover.
 */
export const EndpointLink = ({ endpoint }: EndpointLinkProps) => (
	<a
		className="chip"
		href={endpoint.url}
		onClick={(e: MouseEvent<HTMLAnchorElement>) => e.preventDefault()}
		title={endpoint.url}
		style={{ color: 'var(--c-cyan)', borderColor: 'var(--line)' }}
	>
		<Dot token="cyan" />
		<span className="trunc" style={{ fontSize: 11.5 }}>
			{endpoint.name}
		</span>
		<Icon name="ext" size={12} className="copy-ic" style={{ opacity: 0.6 }} />
	</a>
);
