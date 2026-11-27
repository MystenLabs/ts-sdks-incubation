import { Effect } from "effect";
import { ConsoleApiError } from "./errors";

/**
 * Encode an id as one URL path segment.
 *
 * `encodeURIComponent` escapes `/`, `?` and `#`, but leaves `.` and `..` as they
 * are, and a URL parser resolves those as path navigation: an id of `..` would
 * move the request up a level. No Console id is empty or a dot segment, so both
 * are refused as a typed failure rather than encoded.
 */
export function pathSegment(id: string): Effect.Effect<string, ConsoleApiError> {
  if (id === "" || id === "." || id === "..") {
    return Effect.fail(new ConsoleApiError({ message: `"${id}" is not a valid Console id.` }));
  }
  return Effect.succeed(encodeURIComponent(id));
}
