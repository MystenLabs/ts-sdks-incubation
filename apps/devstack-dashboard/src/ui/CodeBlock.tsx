import { Icon } from './icons.tsx';
import { useCopy } from './useCopy.ts';

/** Move keywords highlighted in magenta. Ported verbatim from the design handoff. */
const MOVE_KW =
	/\b(public|entry|fun|struct|module|use|has|key|store|copy|drop|let|mut|return|if|else|while|loop|abort|const|friend|native|acquires|as|move|spec)\b/g;
/** Move built-in types highlighted in blue. Ported verbatim from the design handoff. */
const MOVE_TY =
	/\b(u8|u16|u32|u64|u128|u256|bool|address|vector|signer|String|Coin|Balance|TxContext|UID|ID|Option)\b/g;

/**
 * Lightweight Move/ABI syntax highlighter. HTML-escapes the line, then layers
 * regex-driven `<span>` colors for comments, strings, keywords, types, and
 * numbers. The result is injected via `dangerouslySetInnerHTML` (intentional).
 */
function highlightMove(line: string): string {
	const esc = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	const html = esc
		.replace(/(\/\/.*$)/g, '<span style="color:var(--tx-dim)">$1</span>')
		.replace(/("[^"]*")/g, '<span style="color:var(--c-green)">$1</span>')
		.replace(MOVE_KW, '<span style="color:var(--c-magenta)">$1</span>')
		.replace(MOVE_TY, '<span style="color:var(--c-blue)">$1</span>')
		.replace(/\b(0x[0-9a-fA-F]+|\d+)\b/g, '<span style="color:var(--c-yellow)">$1</span>');
	return html;
}

export interface CodeBlockProps {
	/** Source code to render (a trailing newline is trimmed). */
	readonly code: string;
	/** Language label shown in the header; also drives highlighting. Defaults to `move`. */
	readonly lang?: string;
	/** Extra classes appended to the wrapper. */
	readonly className?: string;
}

/**
 * Read-only code surface with a language header, a copy button, gutter line
 * numbers, and lightweight regex Move highlighting (see {@link highlightMove}).
 */
export const CodeBlock = ({ code, lang = 'move', className = '' }: CodeBlockProps) => {
	const [copied, copy] = useCopy();
	const lines = code.replace(/\n$/, '').split('\n');
	return (
		<div
			className={`rounded-[9px] border border-line bg-base overflow-hidden ${className}`.trimEnd()}
		>
			<div className="flex items-center justify-between px-[14px] py-[8px] border-b border-line-faint">
				<span className="font-mono text-[11px] text-lo uppercase tracking-[0.08em]">{lang}</span>
				<button className="iconbtn" style={{ width: 24, height: 24 }} onClick={() => copy(code)}>
					<Icon name={copied ? 'check' : 'copy'} size={13} />
				</button>
			</div>
			<pre className="overflow-x-auto px-[14px] py-[10px] m-0 leading-[1.6]">
				{lines.map((l, i) => (
					<div key={i} className="flex gap-[14px]">
						<span
							className="font-mono text-[11px] text-dim select-none text-right"
							style={{ minWidth: 22 }}
						>
							{i + 1}
						</span>
						<code
							className="font-mono text-[12px] text-hi whitespace-pre"
							dangerouslySetInnerHTML={{ __html: highlightMove(l) || '&nbsp;' }}
						/>
					</div>
				))}
			</pre>
		</div>
	);
};
