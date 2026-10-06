import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ConsoleConfig, ConsoleConfigTag } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { ConsoleStorageService, RosterChainDepsTag } from "../src/console/ConsoleStorageService";
import { encodeFileAad } from "../src/console/fileAad";
import type { RosterChainDeps } from "../src/console/rosterVerification";
import { SealCryptoService } from "../src/console/SealCryptoService";
import { BucketId, FileId } from "../src/console/types";
import { boundFile, derivedPolicy, FIXTURE_OWNER, verifiedBucket } from "./verifiedBucket";

/**
 * The wiring between the codec and the decrypt seam: which string the upload
 * binds, and which group and record the download hands the seam.
 */

const BASE_URL = "https://api.testnet.console.walrus.xyz";
const BUCKET = "b7f0b3a0-0000-4000-8000-00000000000a";

const STUB_CONFIG: ConsoleConfig = {
  apiKey: Redacted.make("hbr_working_key_value"),
  servicePrivateKey: Redacted.make("suiprivkey1working"),
  adminKey: Redacted.make(""),
  adminServicePrivateKey: Redacted.make(""),
  baseUrl: BASE_URL,
  webAccountAddress: FIXTURE_OWNER,
  keyAdminAddress: "",
};

let tmpDir: string;
beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-file-binding-"));
});
afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const NO_CHAIN_READS = Layer.succeed(RosterChainDepsTag, {} as RosterChainDeps);

interface EncryptCall {
  plaintext: Uint8Array;
  sealPolicyId: string;
  aad: Uint8Array;
}
interface UploadCall {
  fileName: string;
  contentSize: number | undefined;
  declaredType: string | undefined;
}

function uploadHarness() {
  const encrypts: EncryptCall[] = [];
  const uploads: UploadCall[] = [];
  const api = {
    getBucketById: (id: string) => Effect.succeed(verifiedBucket(BASE_URL, id)),
    uploadBucketFile: (
      _bucketId: string,
      _bytes: Uint8Array,
      fileName: string,
      _metadata: unknown,
      contentSize?: number,
      declaredType?: string,
    ) =>
      Effect.sync(() => {
        uploads.push({ fileName, contentSize, declaredType });
        // Echo the bound columns the real Console 202 body carries, so the
        // post-upload check passes for an honest store.
        return {
          data: {
            id: FileId.make("file-1"),
            original_name: fileName.trim().normalize("NFC"),
            declared_mime_type: declaredType ?? null,
            content_size: contentSize ?? null,
          },
        };
      }),
    getFileUploadStatus: () => Effect.succeed({ data: { state: "completed" as const } }),
  };
  const seal = {
    encrypt: (plaintext: Uint8Array, sealPolicyId: string, aad: Uint8Array) =>
      Effect.sync(() => {
        encrypts.push({ plaintext, sealPolicyId, aad });
        return plaintext;
      }),
  };
  const layer = ConsoleStorageService.DefaultWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ConsoleApiClient, api as unknown as typeof ConsoleApiClient.Service),
        Layer.succeed(SealCryptoService, seal as unknown as typeof SealCryptoService.Service),
        Layer.succeed(ConsoleConfigTag, STUB_CONFIG),
        NO_CHAIN_READS,
      ),
    ),
  );
  const upload = (localPath: string, targetName?: string) =>
    Effect.runPromise(
      ConsoleStorageService.pipe(
        Effect.flatMap((s) =>
          s.uploadFileToBucket(BucketId.make(BUCKET), undefined, localPath, targetName),
        ),
        Effect.provide(layer),
      ),
    );
  return { encrypts, uploads, upload };
}

describe("upload_file binds the record the file will live under", () => {
  it("binds the requested name, the declared type and the plaintext length", async () => {
    const local = path.join(tmpDir, "report.pdf");
    await fs.writeFile(local, "1234567");
    const { encrypts, uploads, upload } = uploadHarness();

    await upload(local);

    expect(encrypts).toHaveLength(1);
    expect(encrypts[0]?.aad).toEqual(
      encodeFileAad({
        bucketId: BUCKET,
        originalName: "report.pdf",
        declaredType: "application/pdf",
        contentSize: 7,
      }),
    );
    // The same declared type goes on the wire, from the same variable, so the
    // bound string and the recorded one cannot come apart.
    expect(uploads[0]).toEqual({
      fileName: "report.pdf",
      contentSize: 7,
      declaredType: "application/pdf",
    });
  });

  // The server stores the NFC form (`toNfcName`), so a client binding the form it
  // read off the filesystem would never match the row it is compared against.
  // macOS hands out NFD, which makes this the ordinary case there, not an edge.
  it("binds the NFC form of a decomposed name", async () => {
    const nfd = "café.pdf";
    const local = path.join(tmpDir, "source-for-nfd.pdf");
    await fs.writeFile(local, "x");
    const { encrypts, upload } = uploadHarness();

    await upload(local, nfd);

    expect(nfd).not.toBe(nfd.normalize("NFC"));
    expect(encrypts[0]?.aad).toEqual(
      encodeFileAad({
        bucketId: BUCKET,
        originalName: nfd.normalize("NFC"),
        declaredType: "application/pdf",
        contentSize: 1,
      }),
    );
  });

  // The plaintext length, not the ciphertext's. This stub returns the plaintext
  // unchanged so the two are equal, which is exactly why the assertion is written
  // against the file on disk instead of against what `encrypt` returned.
  it("binds the size of the bytes read, not of what was uploaded", async () => {
    const local = path.join(tmpDir, "sized.bin");
    await fs.writeFile(local, Buffer.alloc(4096, 7));
    const { encrypts, uploads, upload } = uploadHarness();

    await upload(local);

    expect(uploads[0]?.contentSize).toBe(4096);
    expect(encrypts[0]?.aad).toEqual(
      encodeFileAad({
        bucketId: BUCKET,
        originalName: "sized.bin",
        declaredType: "application/octet-stream",
        contentSize: 4096,
      }),
    );
  });

  it.each([
    {
      label: "all-null columns",
      stored: {
        id: FileId.make("file-bad"),
        original_name: null,
        declared_mime_type: null,
        content_size: null,
      },
    },
    {
      label: "wrong original_name",
      stored: {
        id: FileId.make("file-bad-name"),
        original_name: "other.txt",
        declared_mime_type: "text/plain",
        content_size: 2,
      },
    },
    {
      label: "wrong declared_mime_type",
      stored: {
        id: FileId.make("file-bad-mime"),
        original_name: "mismatch-bind.txt",
        declared_mime_type: "application/octet-stream",
        content_size: 2,
      },
    },
    {
      label: "wrong content_size",
      stored: {
        id: FileId.make("file-bad-size"),
        original_name: "mismatch-bind.txt",
        declared_mime_type: "text/plain",
        content_size: 99,
      },
    },
  ] as const)("fails when the 202 body does not match the binding ($label)", async ({ stored }) => {
    const local = path.join(tmpDir, "mismatch-bind.txt");
    await fs.writeFile(local, "hi");

    const api = {
      getBucketById: (id: string) => Effect.succeed(verifiedBucket(BASE_URL, id)),
      uploadBucketFile: () => Effect.succeed({ data: stored }),
      getFileUploadStatus: () => Effect.succeed({ data: { state: "completed" as const } }),
    };
    const seal = {
      encrypt: (plaintext: Uint8Array, _sealPolicyId: string, _aad: Uint8Array) =>
        Effect.succeed(plaintext),
    };
    const layer = ConsoleStorageService.DefaultWithoutDependencies.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ConsoleApiClient, api as unknown as typeof ConsoleApiClient.Service),
          Layer.succeed(SealCryptoService, seal as unknown as typeof SealCryptoService.Service),
          Layer.succeed(ConsoleConfigTag, STUB_CONFIG),
          NO_CHAIN_READS,
        ),
      ),
    );

    const result = await Effect.runPromise(
      ConsoleStorageService.pipe(
        Effect.flatMap((s) => s.uploadFileToBucket(BucketId.make(BUCKET), undefined, local)),
        Effect.either,
        Effect.provide(layer),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      const left = result.left as { _tag?: string; fileId?: string; message?: string };
      expect(left._tag).toBe("UploadBindingStoredUnreadableError");
      expect(left.fileId).toBe(stored.id);
      expect(left.message).toContain("stored but unreadable");
      expect(left.message).toContain("Do not retry");
    }
  });
});

interface DecryptCall {
  bucketId: string;
  fileId: string;
  expectedGroupId: string;
  record: unknown;
}

function downloadHarness(
  opts: {
    reportedPolicy?: string | null;
    visibility?: "public" | "private";
    /** An explicit value for the column. */
    creator?: string | null;
    /**
     * Drop the field entirely, which is what a Console that predates it returns.
     * A separate flag, because `creator: undefined` in an options object is
     * indistinguishable from not passing it at all — and those are the two cases
     * this test has to tell apart.
     */
    creatorAbsent?: boolean;
    recordName?: string;
    authenticatedName?: string | null;
    bound?: boolean;
    fileBucketId?: string;
    metadata?: Record<string, unknown> | null;
  } = {},
) {
  const calls: DecryptCall[] = [];
  const api = {
    getBucketById: (id: string) =>
      Effect.sync(() => {
        const bucket = verifiedBucket(BASE_URL, id, {
          ...(opts.reportedPolicy !== undefined ? { sealPolicyId: opts.reportedPolicy } : {}),
          ...(opts.visibility !== undefined ? { visibility: opts.visibility } : {}),
        });
        if (opts.creatorAbsent) {
          const { creator: _dropped, ...withoutCreator } = bucket;
          return withoutCreator as typeof bucket;
        }
        return opts.creator !== undefined ? { ...bucket, creator: opts.creator } : bucket;
      }),
    getBucketFile: (_b: string, f: string) =>
      Effect.succeed(
        boundFile(f, {
          ...(opts.recordName !== undefined ? { name: opts.recordName } : {}),
          // A record whose own `bucket_id` points somewhere else. The binding must
          // be compared against the bucket the CALLER addressed, so this value
          // must not reach the check.
          ...(opts.fileBucketId !== undefined ? { bucketId: opts.fileBucketId } : {}),
          ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
        }),
      ),
    downloadBucketFile: () => Effect.succeed(new Uint8Array([1, 2, 3])),
  };
  const seal = {
    decrypt: (ciphertext: Uint8Array, binding: DecryptCall) =>
      Effect.sync(() => {
        calls.push(binding);
        return {
          plaintext: ciphertext,
          authenticatedName: opts.authenticatedName ?? null,
          bound: opts.bound ?? false,
        };
      }),
  };
  const layer = ConsoleStorageService.DefaultWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ConsoleApiClient, api as unknown as typeof ConsoleApiClient.Service),
        Layer.succeed(SealCryptoService, seal as unknown as typeof SealCryptoService.Service),
        Layer.succeed(ConsoleConfigTag, STUB_CONFIG),
        NO_CHAIN_READS,
      ),
    ),
  );
  const download = (name: string) =>
    Effect.runPromise(
      ConsoleStorageService.pipe(
        Effect.flatMap((s) =>
          s.downloadFile(BucketId.make(BUCKET), FileId.make("file-1"), path.join(tmpDir, name)),
        ),
        Effect.either,
        Effect.provide(layer),
      ),
    );
  return { calls, download };
}

describe("download_file verifies against the record and the derived group", () => {
  // The whole point of the change. `seal_policy_id` is a column an operator who
  // can re-point a file can also re-point; the derivation is not.
  it("hands the seam the derived group, not the policy the bucket reports", async () => {
    const reported = `0x${"9".repeat(64)}`;
    const { calls, download } = downloadHarness({ reportedPolicy: reported });

    const result = await download("derived.out");

    expect(result._tag).toBe("Right");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.expectedGroupId).toBe(derivedPolicy(BASE_URL, BUCKET, FIXTURE_OWNER));
    expect(calls[0]?.expectedGroupId).not.toBe(reported);
  });

  // Comparing the record against its own `bucket_id` would authenticate nothing,
  // and that column is exactly what a cross-bucket swap rewrites.
  it("compares against the bucket the caller addressed, never the record's own", async () => {
    const { calls, download } = downloadHarness({
      fileBucketId: "00000000-0000-4000-8000-000000000999",
    });

    await download("caller-bucket.out");

    expect(calls[0]?.bucketId).toBe(BUCKET);
  });

  it("hands the seam the three bound columns off the record", async () => {
    const { calls, download } = downloadHarness({ recordName: "report.pdf" });

    await download("record.out");

    expect(calls[0]?.record).toMatchObject({
      original_name: "report.pdf",
      declared_mime_type: "application/octet-stream",
      content_size: 3,
    });
  });

  // No creator means the group cannot be recomputed, so there is nothing to verify against.
  it("refuses a private bucket whose creator is missing", async () => {
    // Both shapes: the column read back as NULL, and a Console build that does not
    // return the field at all.
    for (const [label, opts] of [
      ["null", { creator: null }],
      ["absent", { creatorAbsent: true }],
    ] as const) {
      const { calls, download } = downloadHarness(opts);

      const result = await download(`no-creator-${label}.out`);

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        const left = result.left as { _tag?: string; reason?: string; message?: string };
        expect(left._tag).toBe("FileBindingRefusedError");
        expect(left.reason).toBe("missing_creator");
        // The message, not just the tag: without the guard this still refuses, but as
        // "could not derive", which points at config instead of the missing column.
        expect(left.message).toContain("reports no creator");
      }
      // Refused before the seam was reached, so no key was ever fetched.
      expect(calls).toEqual([]);
    }
  });

  // A public folder holds no ciphertext, and `download_file` decrypts
  // unconditionally, so it could never have worked there. Before this it failed at
  // `EncryptedObject.parse` with a message about a malformed Seal object.
  // Visibility alone drives not_private — including when a seal_policy_id is present.
  it.each([
    { label: "null policy", reportedPolicy: null as string | null },
    { label: "non-null policy", reportedPolicy: `0x${"a".repeat(64)}` },
  ])("refuses a public folder by saying so ($label)", async ({ reportedPolicy }) => {
    const { calls, download } = downloadHarness({
      visibility: "public",
      reportedPolicy,
    });

    const result = await download("public.out");

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      const left = result.left as { _tag?: string; reason?: string; message?: string };
      expect(left._tag).toBe("FileBindingRefusedError");
      expect(left.reason).toBe("not_private");
      expect(left.message).toContain("is public");
      expect(left.message).not.toContain("Fetch the file");
    }
    expect(calls).toEqual([]);
  });

  it("refuses a private folder with no seal_policy_id as missing_policy, not public", async () => {
    const { calls, download } = downloadHarness({ reportedPolicy: null });

    const result = await download("missing-policy.out");

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      const left = result.left as { _tag?: string; reason?: string; message?: string };
      expect(left._tag).toBe("FileBindingRefusedError");
      expect(left.reason).toBe("missing_policy");
      expect(left.message).toContain("private but reports no seal_policy_id");
      expect(left.message).toContain("incomplete");
    }
    expect(calls).toEqual([]);
  });

  // Accepted forever, and said so rather than reported as verified: every file
  // the MCP uploaded before this release is in this lane.
  it("reports a pre-cutover file as unbound, and writes it", async () => {
    const { download } = downloadHarness({ bound: false });

    const result = await download("legacy.out");

    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right).toMatchObject({ bound: false });
      expect(result.right).not.toHaveProperty("uploadedAs");
      expect(result.right).not.toHaveProperty("warning");
    }
  });

  it("warns when a stamped row still took the legacy decrypt lane", async () => {
    const { download } = downloadHarness({
      bound: false,
      metadata: { aadVersion: 1 },
    });

    const result = await download("stamped-legacy.out");

    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right).toMatchObject({ bound: false });
      expect(result.right).toHaveProperty("warning");
      expect(String((result.right as { warning?: string }).warning)).toContain("aadVersion");
    }
  });

  // A rewrite that changes every bound column consistently passes the compare, so
  // the authenticated name is the one thing left that disagrees.
  it("reports the authenticated name when it differs from the record's", async () => {
    const { download } = downloadHarness({
      bound: true,
      recordName: "invoice.pdf",
      authenticatedName: "the-real-name.pdf",
    });

    const result = await download("uploaded-as.out");

    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right).toMatchObject({ bound: true, uploadedAs: "the-real-name.pdf" });
    }
  });

  it("stays quiet when the authenticated name agrees with the record", async () => {
    const { download } = downloadHarness({
      bound: true,
      recordName: "agreed.pdf",
      authenticatedName: "agreed.pdf",
    });

    const result = await download("agreed.out");

    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right).not.toHaveProperty("uploadedAs");
    }
  });
});
