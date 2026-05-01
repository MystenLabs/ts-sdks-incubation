// 64-by-64 generic key-shaped icon, base64-encoded SVG. Inlined so the wallet
// is renderable in any environment (browser, jsdom, node) without an icon file.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#38bdf8"/><stop offset="1" stop-color="#6366f1"/>
</linearGradient></defs>
<rect width="64" height="64" rx="14" fill="url(#g)"/>
<path d="M40 22a8 8 0 1 0-9.5 7.85V41h-3v3h3v3h-3v3h3v3h6v-15.15A8 8 0 0 0 40 22Zm-8 3a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z" fill="#fff"/>
</svg>`;

export const DEV_WALLET_ICON: `data:image/svg+xml;base64,${string}` =
	`data:image/svg+xml;base64,${btoa(SVG)}` as `data:image/svg+xml;base64,${string}`;
