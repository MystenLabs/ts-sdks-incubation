// Subprocess probe: dynamic-import a plugin barrel and print a sentinel
// on success. Invoked as `node --import tsx/esm probe-load.cjs <path>
// <sentinel>`. Lives at .cjs so vitest's test-file glob never sucks it
// in as a test. The probe itself is plain CommonJS to keep the surface
// small; tsx/esm handles the .ts dynamic import.

const [, , barrelPath, sentinel] = process.argv;

if (!barrelPath || !sentinel) {
	console.error('usage: node --import tsx/esm probe-load.cjs <barrelPath> <sentinel>');
	process.exit(2);
}

(async () => {
	try {
		const m = await import(barrelPath);
		if (m == null || typeof m !== 'object') {
			console.error(`probe-load: module is ${typeof m}`);
			process.exit(3);
		}
		console.log(sentinel);
	} catch (err) {
		console.error(err && err.stack ? err.stack : String(err));
		process.exit(4);
	}
})();
