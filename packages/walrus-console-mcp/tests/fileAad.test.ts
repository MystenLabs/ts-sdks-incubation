import { describe, expect, it } from "vitest";
import {
  canonicalBucketId,
  canonicalOriginalName,
  classifyFileAad,
  encodeFileAad,
  FILE_AAD_VERSION,
} from "../src/console/fileAad";

/**
 * `src/console/fileAad.ts` mirrors Console's
 * `ts-sdks/packages/bucket-groups/src/file-aad.ts`, and a mirror tested only
 * against itself proves nothing. Every `aadHex` below is hex the CANONICAL
 * implementation emitted for the inputs beside it; regenerate it the same way.
 * If the bytes move, the two clients no longer share a format.
 */
const VECTORS = [
  {
    label: "plain ascii",
    bucketId: "b7f0b3a0-0000-4000-8000-00000000000a",
    originalName: "report.pdf",
    declaredType: "application/pdf",
    contentSize: 1024,
    aadHex:
      "012462376630623361302d303030302d343030302d383030302d3030303030303030303030610a7265706f72742e7064660f6170706c69636174696f6e2f7064660004000000000000",
  },
  {
    label: "empty declared type",
    bucketId: "b7f0b3a0-0000-4000-8000-00000000000a",
    originalName: "blob.bin",
    declaredType: "",
    contentSize: 0,
    aadHex:
      "012462376630623361302d303030302d343030302d383030302d30303030303030303030306108626c6f622e62696e000000000000000000",
  },
  {
    label: "uppercase bucket id canonicalises",
    bucketId: "B7F0B3A0-0000-4000-8000-00000000000A",
    originalName: "a.txt",
    declaredType: "text/plain",
    contentSize: 1,
    aadHex:
      "012462376630623361302d303030302d343030302d383030302d30303030303030303030306105612e7478740a746578742f706c61696e0100000000000000",
  },
  {
    label: "multi-byte utf-8 name",
    bucketId: "b7f0b3a0-0000-4000-8000-00000000000a",
    originalName: "hồ sơ.pdf",
    declaredType: "application/pdf",
    contentSize: 7,
    aadHex:
      "012462376630623361302d303030302d343030302d383030302d3030303030303030303030610c68e1bb932073c6a12e7064660f6170706c69636174696f6e2f7064660700000000000000",
  },
  {
    label: "quote and percent-escape in the name",
    bucketId: "b7f0b3a0-0000-4000-8000-00000000000a",
    originalName: 'a"b%22c.pdf',
    declaredType: "application/pdf",
    contentSize: 3,
    aadHex:
      "012462376630623361302d303030302d343030302d383030302d3030303030303030303030610b612262253232632e7064660f6170706c69636174696f6e2f7064660300000000000000",
  },
  {
    label: "content size above 2^32",
    bucketId: "b7f0b3a0-0000-4000-8000-00000000000a",
    originalName: "big.iso",
    declaredType: "application/octet-stream",
    contentSize: 4294967296n,
    aadHex:
      "012462376630623361302d303030302d343030302d383030302d303030303030303030303061076269672e69736f186170706c69636174696f6e2f6f637465742d73747265616d0000000001000000",
  },
  {
    label: "nfd name bound as nfc",
    bucketId: "b7f0b3a0-0000-4000-8000-00000000000a",
    // Decomposed (NFD) input — encode path runs canonicalOriginalName first.
    originalName: "cafe\u0301.pdf",
    declaredType: "application/pdf",
    contentSize: 5,
    aadHex:
      "012462376630623361302d303030302d343030302d383030302d30303030303030303030306109636166c3a92e7064660f6170706c69636174696f6e2f7064660500000000000000",
  },
  {
    label: "name with surrounding whitespace trimmed",
    bucketId: "b7f0b3a0-0000-4000-8000-00000000000a",
    originalName: "  spaced.txt  ",
    declaredType: "text/plain",
    contentSize: 2,
    aadHex:
      "012462376630623361302d303030302d343030302d383030302d3030303030303030303030610a7370616365642e7478740a746578742f706c61696e0200000000000000",
  },
  {
    label: "name of 128+ bytes uses two-byte BCS length prefix",
    bucketId: "b7f0b3a0-0000-4000-8000-00000000000a",
    originalName:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.txt",
    declaredType: "text/plain",
    contentSize: 1,
    aadHex:
      "012462376630623361302d303030302d343030302d383030302d303030303030303030303061840161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161612e7478740a746578742f706c61696e0100000000000000",
  },
] as const;

describe("file-AAD v1 golden vectors from the Console SDK", () => {
  it("is version 1", () => {
    expect(FILE_AAD_VERSION).toBe(1);
  });

  it.each(VECTORS)(
    "encodes $label to the bytes the SDK produced",
    ({ bucketId, originalName, declaredType, contentSize, aadHex }) => {
      // Callers bind the canonical form; encodeFileAad itself does not normalise.
      const encoded = encodeFileAad({
        bucketId,
        originalName: canonicalOriginalName(originalName),
        declaredType,
        contentSize,
      });
      expect(Buffer.from(encoded).toString("hex")).toBe(aadHex);
    },
  );

  // The encode side is only half of interop. The same bytes have to classify as
  // `bound` against the record the server stores for them, which is the
  // direction a download actually runs.
  it.each(VECTORS)(
    "accepts the SDK's bytes for $label against the record they describe",
    ({ bucketId, originalName, declaredType, contentSize, aadHex }) => {
      const result = classifyFileAad(Buffer.from(aadHex, "hex"), {
        bucketId,
        record: {
          // The server stores the canonical form; that is what classify compares.
          original_name: canonicalOriginalName(originalName),
          declared_mime_type: declaredType,
          content_size: contentSize,
        },
      });

      expect(result.kind).toBe("bound");
    },
  );
});

describe("classifyFileAad refusals", () => {
  const BUCKET = "b7f0b3a0-0000-4000-8000-00000000000a";
  const record = {
    original_name: "report.pdf",
    declared_mime_type: "application/pdf",
    content_size: 1024,
  };
  const bound = () =>
    encodeFileAad({
      bucketId: BUCKET,
      originalName: record.original_name,
      declaredType: record.declared_mime_type,
      contentSize: record.content_size,
    });

  // Refused as `unreadable`, not `mismatch`: the reader's client is too old, the file
  // was not swapped. Without the version check it would still refuse, for the wrong reason.
  it("refuses an unknown version as unreadable, not as a mismatch", () => {
    const future = bound();
    future[0] = 2;

    const result = classifyFileAad(future, { bucketId: BUCKET, record });

    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.reason).toBe("unreadable");
      expect(result.detail).toContain("version 2");
    }
  });

  it("refuses bytes that are not a v1 struct at all", () => {
    const result = classifyFileAad(new Uint8Array([0xff, 0xff, 0xff]), {
      bucketId: BUCKET,
      record,
    });

    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("unreadable");
  });

  it("refuses one flipped byte", () => {
    const tampered = bound();
    const last = tampered.length - 1;
    tampered.set([(tampered[last] as number) ^ 0x01], last);

    expect(classifyFileAad(tampered, { bucketId: BUCKET, record }).kind).toBe("refused");
  });

  it("refuses a bound ciphertext over a record missing any one column", () => {
    for (const column of ["original_name", "declared_mime_type", "content_size"] as const) {
      const result = classifyFileAad(bound(), {
        bucketId: BUCKET,
        record: { ...record, [column]: null },
      });

      expect(result.kind).toBe("refused");
      if (result.kind === "refused") expect(result.reason).toBe("record_not_bound");
    }
  });

  // `content_size` has no CHECK in Console's database, so a rewrite can store -1.
  it("refuses a record whose size no u64 can hold, rather than throwing", () => {
    for (const content_size of [-1, 3.5, Number.NaN, 2 ** 64, -1n, 2n ** 64n]) {
      const result = classifyFileAad(bound(), {
        bucketId: BUCKET,
        record: { ...record, content_size },
      });
      expect(result).toMatchObject({
        kind: "refused",
        reason: "record_not_bound",
        detail: expect.stringContaining("size"),
      });
    }
  });

  // Only the size gets the size message: the guard runs by name before encoding.
  it("refuses a record with a non-string name without blaming the size", () => {
    const result = classifyFileAad(bound(), {
      bucketId: BUCKET,
      record: { ...record, original_name: 123 as unknown as string },
    });

    expect(result).toMatchObject({ kind: "refused", reason: "record_not_bound" });
    expect(result.kind === "refused" && result.detail).not.toContain("size");
  });

  it("refuses a ciphertext bound to another folder", () => {
    const result = classifyFileAad(bound(), {
      bucketId: "00000000-0000-4000-8000-000000000999",
      record,
    });

    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("mismatch");
  });

  it("runs the legacy lane for an absent or empty AAD", () => {
    for (const aad of [null, undefined, new Uint8Array()]) {
      expect(classifyFileAad(aad, { bucketId: BUCKET, record }).kind).toBe("legacy");
    }
  });
});

describe("canonical forms", () => {
  // macOS hands out NFD from the filesystem while the server stores NFC, so a
  // name bound in the form it was read in would never match the row.
  it("binds the NFC form of a decomposed name", () => {
    const nfd = "cafe\u0301.pdf";
    expect(nfd).not.toBe(nfd.normalize("NFC"));
    expect(canonicalOriginalName(nfd)).toBe("café.pdf");
  });

  it("trims the name, because the server's schema does", () => {
    expect(canonicalOriginalName("  spaced.txt  ")).toBe("spaced.txt");
  });

  // The bucket id arrives as a tool argument here, so its casing is whatever the
  // agent typed. Without this an agent that types capitals uploads a file that
  // can never be downloaded.
  it("lowercases a bucket id the caller typed in capitals", () => {
    expect(canonicalBucketId("B7F0B3A0-0000-4000-8000-00000000000A")).toBe(
      "b7f0b3a0-0000-4000-8000-00000000000a",
    );
  });
});
