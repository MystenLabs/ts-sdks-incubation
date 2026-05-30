// substrate/runtime/sui-ledger — `ledgerService.getObject` workaround.
//
// `SuiSdkShim.core.getObject` returns the simplified `core`-surface
// projection (no version/digest) per `@mysten/sui`'s `ClientWithCoreApi`
// shape. The gRPC ledger service provides the BCS-encoded object
// envelope WITH version + digest under a `readMask` projection — see
// `@mysten/sui/docs/clients/grpc.md` § Ledger service.
//
// The cast `sdk.client as unknown as {ledgerService: {…}}` is the
// sanctioned escape hatch — `ClientWithCoreApi` doesn't structurally
// overlap with the gRPC `{ledgerService}` shape, so a direct cast fails.
// Folded into one substrate-side helper so every plugin that needs an
// up-to-date `{objectId, version, digest}` ObjectRef goes through the
// same projection (and the same `unknown`-cast escape hatch) rather
// than re-deriving it.
//
// NOTE: not exported from the public barrel — this is an internal
// substrate primitive used by plugins, not a published API.
//
// Sibling of `substrate/runtime/sui-execute/` — same opacity discipline
// (no `@mysten/sui/client` type import; the opaque `SuiSdkShim` carries
// the client through).

import type { SuiSdkShim } from '../../../plugins/sui/index.ts';

/** Shape of the gRPC ledger-service projection we need. Hand-written
 *  because the public `ClientWithCoreApi` surface doesn't include the
 *  ledger service. */
interface LedgerObjectClient {
	readonly ledgerService: {
		readonly getObject: (args: {
			readonly objectId: string;
			readonly readMask?: { readonly paths: ReadonlyArray<string> };
		}) => Promise<{
			readonly response?: {
				readonly object?: {
					readonly objectId?: string;
					readonly version?: string | number | bigint;
					readonly digest?: string;
				};
			};
		}>;
	};
}

/** Re-cast a `SuiSdkShim` as the gRPC ledger-service client. The
 *  `unknown` hop is required because `ClientWithCoreApi` doesn't
 *  structurally overlap with `{ledgerService: …}`. */
const ledgerObjectClient = (sdk: SuiSdkShim): LedgerObjectClient =>
	sdk.client as unknown as LedgerObjectClient;

/** Up-to-date `{objectId, version, digest}` ObjectRef for `objectId`,
 *  fetched through the gRPC ledger service.
 *
 *  Throws if the response envelope is missing any of `objectId` /
 *  `version` / `digest` — e.g. when the object was deleted or never
 *  existed. The error message includes the requested object id so
 *  call-site context surfaces in plugin error traces. */
export const currentLedgerObjectRef = async (
	sdk: SuiSdkShim,
	objectId: string,
): Promise<{
	readonly objectId: string;
	readonly version: string;
	readonly digest: string;
}> => {
	const raw = await ledgerObjectClient(sdk).ledgerService.getObject({
		objectId,
		readMask: { paths: ['object_id', 'version', 'digest'] },
	});
	const object = raw.response?.object;
	if (
		object === undefined ||
		object.objectId === undefined ||
		object.version === undefined ||
		object.digest === undefined
	) {
		throw new Error(
			`currentLedgerObjectRef: object '${objectId}' was not found (response missing one of objectId/version/digest).`,
		);
	}
	return {
		objectId: object.objectId,
		version: object.version.toString(),
		digest: object.digest,
	};
};
