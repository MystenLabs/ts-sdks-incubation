// Node 22+ ships a built-in `localStorage` global (via a getter) that
// returns a non-functional stub object unless Node was started with a
// valid `--localstorage-file=<path>`. Vitest 4's happy-dom environment
// adopts that broken object instead of installing its own Storage — so
// `localStorage.clear()` etc throw at test time.
//
// Fix: instantiate a fresh happy-dom `Window` ourselves and overwrite
// `globalThis.localStorage` / `sessionStorage` with the working
// implementations. The setup is a no-op in `node`-env test files where
// `globalThis.window` is undefined.

const w = (globalThis as { window?: unknown }).window;
if (w !== undefined) {
	// Re-import dynamically so the `Window` constructor pulls from
	// happy-dom's installed package — we don't want to bundle it as a
	// top-level static import that fires in `node`-env tests too.
	const { Window } = await import('happy-dom');
	const dom = new Window();
	Object.defineProperty(globalThis, 'localStorage', {
		value: dom.localStorage,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(globalThis, 'sessionStorage', {
		value: dom.sessionStorage,
		configurable: true,
		writable: true,
	});
}
