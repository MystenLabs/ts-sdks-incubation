// Wallet plugin span-attribute vocabulary. Plugin-local — substrate's
// `SpanAttr` carries only engine-dimensional + http/process generic
// keys; plugin-domain keys live next to the plugin that owns them.
//
// Callsite pattern: `Effect.annotateCurrentSpan({ [WalletSpans.token]:
// value })`. Free-form string literals are a STYLE_GUIDE §16 violation.

export const WalletSpans = {
	accountCount: 'wallet.accountCount',
	app: 'wallet.app',
	bearerValid: 'wallet.auth.bearerValid',
	chain: 'wallet.chain',
	codegenPairUrl: 'wallet.codegen.pairUrl',
	codegenWalletUrl: 'wallet.codegen.walletUrl',
	localPort: 'wallet.localPort',
	origin: 'wallet.origin',
	requestId: 'wallet.request.id',
	requestMethod: 'wallet.request.method',
	requestUrl: 'wallet.request.url',
	stack: 'wallet.stack',
	token: 'wallet.token',
	tokenFile: 'wallet.tokenFile',
	url: 'wallet.url',
} as const;
