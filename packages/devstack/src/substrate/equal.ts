// Type-level equality + assertion helpers used across the package
// for compile-time invariants. Pure type primitives.

export type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

export type Expect<T extends true> = T;

export type Not<T extends boolean> = T extends true ? false : true;

/** `Assert<T>` is a no-op type-level assertion: `T` must extend
 *  `true`. Use to encode invariants that should error on regression. */
export type Assert<T extends true> = T;
