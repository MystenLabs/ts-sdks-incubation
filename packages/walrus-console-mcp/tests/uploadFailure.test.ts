import { describe, expect, it } from "vitest";
import {
  interpretUploadFailure,
  uploadsBlockedUntil,
  uploadsPausedMessage,
} from "../src/console/uploadFailure";

// The condition table is the contract an agent programs against; the guidance
// sentence is what it reads.

const RETRY_AT = "2026-09-23T08:15:30Z";
const NOW = Date.parse("2026-09-23T07:15:30Z");

describe("interpretUploadFailure", () => {
  it.each([
    ["upload_daily_funding_limit", "daily_limit"],
    ["upload_funding_paused", "funding_paused"],
    ["upload_cap_exceeded", "storage_cap"],
    ["upload_wallet_funding_required", "transient"],
    ["upload_rate_limited", "transient"],
    ["upload_unauthorized", "transient"],
    ["upload_funding_failed", "transient"],
    ["upload_funding_pending", "transient"],
    ["upload_funding_gave_up", "transient"],
    ["upload_funding_timeout", "transient"],
    ["upload_upstream_unavailable", "transient"],
    ["upload_payload_too_large", "permanent"],
    ["upload_bucket_not_found", "permanent"],
    ["upload_quota_rejected", "permanent"],
    ["upload_funding_below_min_shortfall", "permanent"],
    ["upload_bucket_gone", "permanent"],
    ["upload_failed", "permanent"],
  ])("maps %s to %s", (code, condition) => {
    expect(interpretUploadFailure({ code, message: "x" }).condition).toBe(condition);
  });

  it("tells a daily-limit caller to stop until the resume time", () => {
    const { guidance } = interpretUploadFailure({
      code: "upload_daily_funding_limit",
      message: "x",
      retry_at: RETRY_AT,
    });
    expect(guidance).toMatch(/stop uploading to this account until 2026-09-23T08:15:30Z/i);
    expect(guidance).toMatch(/stop the batch/i);
  });

  it("says a daily limit without a time means this file never fits, not to wait", () => {
    const { guidance } = interpretUploadFailure({
      code: "upload_daily_funding_limit",
      message: "x",
    });
    expect(guidance).toMatch(/cannot be uploaded under the limit/i);
    expect(guidance).toMatch(/waiting will not help/i);
    expect(guidance).not.toMatch(/24 hours/);
  });

  it("says a funding pause is service-wide, with a time only when one was given", () => {
    const windowed = interpretUploadFailure({
      code: "upload_funding_paused",
      message: "x",
      retry_at: RETRY_AT,
    });
    expect(windowed.guidance).toMatch(/service-wide/);
    expect(windowed.guidance).toContain(RETRY_AT);
    const killed = interpretUploadFailure({ code: "upload_funding_paused", message: "x" });
    expect(killed.guidance).toMatch(/until an operator lifts the pause/);
  });

  it("falls back to permanent for a code this build does not know, and says so", () => {
    const reading = interpretUploadFailure({ code: "upload_something_new", message: "x" });
    expect(reading.condition).toBe("permanent");
    expect(reading.guidance).toMatch(/does not recognise the code/);
  });

  it("treats a failed status with no error as permanent", () => {
    expect(interpretUploadFailure(undefined).condition).toBe("permanent");
  });
});

describe("uploadsBlockedUntil", () => {
  it("blocks a daily limit for retry_after_seconds from now", () => {
    expect(
      uploadsBlockedUntil(
        {
          code: "upload_daily_funding_limit",
          message: "x",
          retry_at: RETRY_AT,
          retry_after_seconds: 60,
        },
        NOW,
      ),
    ).toEqual({ until: NOW + 60_000, retryAt: RETRY_AT });
  });

  it("falls back to retry_at when the seconds are missing", () => {
    expect(
      uploadsBlockedUntil(
        { code: "upload_daily_funding_limit", message: "x", retry_at: RETRY_AT },
        NOW,
      )?.until,
    ).toBe(Date.parse(RETRY_AT));
  });

  it("does not block a funding pause, a daily limit without a time, or other conditions", () => {
    for (const error of [
      { code: "upload_funding_paused", message: "x", retry_at: RETRY_AT, retry_after_seconds: 60 },
      { code: "upload_daily_funding_limit", message: "x" },
      { code: "upload_cap_exceeded", message: "x", retry_at: RETRY_AT },
      { code: "upload_rate_limited", message: "x", retry_at: RETRY_AT },
    ]) {
      expect(uploadsBlockedUntil(error, NOW)).toBeUndefined();
    }
    expect(uploadsBlockedUntil(undefined, NOW)).toBeUndefined();
  });

  it("does not block once the time has passed", () => {
    expect(
      uploadsBlockedUntil(
        {
          code: "upload_daily_funding_limit",
          message: "x",
          retry_at: RETRY_AT,
          retry_after_seconds: 0,
        },
        NOW,
      ),
    ).toBeUndefined();
  });

  it("refuses with the daily-limit guidance, not the first failure's message", () => {
    const message = uploadsPausedMessage({ until: NOW + 1, retryAt: RETRY_AT });
    expect(message).toMatch(/refused without an API call/i);
    expect(message).toContain(RETRY_AT);
  });
});
