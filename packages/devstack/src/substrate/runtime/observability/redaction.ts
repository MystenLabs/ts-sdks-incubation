import { Context, Effect, Layer, Ref } from 'effect';

export type RedactionRule =
	| {
			readonly kind: 'literal';
			readonly value: string;
			readonly replacement?: string;
	  }
	| {
			readonly kind: 'pattern';
			readonly pattern: RegExp;
			readonly replacement?: string;
	  };

export interface RedactorShape {
	readonly register: (rule: RedactionRule) => Effect.Effect<void>;
	readonly redact: (text: string) => Effect.Effect<string>;
	readonly rules: Effect.Effect<ReadonlyArray<RedactionRule>>;
}

export class Redactor extends Context.Service<Redactor, RedactorShape>()(
	'@devstack/substrate/Redactor',
) {}

const DEFAULT_REPLACEMENT = '<redacted>';

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** A non-global pattern redacts only its FIRST match — every later
 *  occurrence leaks. Force the global flag so all occurrences are
 *  redacted; clone (don't mutate the caller's RegExp) and preserve any
 *  unicode flag. Already-global patterns pass through untouched so we
 *  don't double-apply. */
const asGlobalPattern = (pattern: RegExp): RegExp =>
	pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);

export const redactText = (text: string, rules: ReadonlyArray<RedactionRule>): string => {
	let next = text;
	for (const rule of rules) {
		const replacement = rule.replacement ?? DEFAULT_REPLACEMENT;
		if (rule.kind === 'literal') {
			if (rule.value.length === 0) continue;
			next = next.replace(new RegExp(escapeRegExp(rule.value), 'gu'), replacement);
		} else {
			next = next.replace(asGlobalPattern(rule.pattern), replacement);
		}
	}
	return next;
};

export const redactValue = (
	value: unknown,
	rules: ReadonlyArray<RedactionRule>,
	visited: WeakSet<object> = new WeakSet(),
): unknown => {
	if (typeof value === 'string') return redactText(value, rules);
	if (typeof value !== 'object' || value === null) return value;
	if (visited.has(value)) return value;
	visited.add(value);
	if (Array.isArray(value)) return value.map((entry) => redactValue(entry, rules, visited));
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		out[key] = redactValue(entry, rules, visited);
	}
	return out;
};

export const layerRedactor: Layer.Layer<Redactor> = Layer.effect(
	Redactor,
	Effect.gen(function* () {
		const ref = yield* Ref.make<ReadonlyArray<RedactionRule>>([]);
		return Redactor.of({
			register: (rule) => Ref.update(ref, (rules) => [...rules, rule]),
			redact: (text) => Ref.get(ref).pipe(Effect.map((rules) => redactText(text, rules))),
			rules: Ref.get(ref),
		});
	}),
);
