/**
 * Subfolder input rules, mirrored from the Console API's `folderNameZodSchema`
 * (`api/src/lib/name-schemas.ts`) and the folder description schema
 * (`api/src/api/routes/folders.ts`, `MAX_FOLDER_DESCRIPTION_LENGTH`), so a
 * name Console would refuse fails here with the same message instead of a 400.
 *
 * The checks run on the trimmed NFC form, the form Console stores and measures.
 * The value is sent as typed: Console normalises it itself, and sending the raw
 * string keeps the request identical to what the web app sends.
 */

import { z } from "zod";

export const MAX_FOLDER_NAME_LENGTH = 255;
export const MAX_FOLDER_DESCRIPTION_LENGTH = 1000;

const SLASH_RE = /[/\\]/;
const ANGLE_RE = /[<>]/;
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHAR_EXCEPT_WHITESPACE_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
// A lone surrogate: what `String.prototype.isWellFormed` refuses on Console's side.
// Spelled out because this package's TypeScript lib predates that method.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const toStoredForm = (value: string): string => value.trim().normalize("NFC");

/** The first rule a folder name breaks, in Console's wording, or undefined. */
export function folderNameProblem(raw: string): string | undefined {
  const name = toStoredForm(raw);
  if (name.length === 0) return "Name can't be empty.";
  if (name.length > MAX_FOLDER_NAME_LENGTH)
    return `Name must be ${MAX_FOLDER_NAME_LENGTH} characters or fewer.`;
  if (name === "." || name === "..") return "Name can't be . or ..";
  if (name.endsWith(".")) return "Name can't end with a period.";
  if (SLASH_RE.test(name)) return "Name can't contain slashes.";
  if (ANGLE_RE.test(name)) return "Name can't contain < or >.";
  if (CONTROL_CHAR_RE.test(name) || LONE_SURROGATE_RE.test(name))
    return "Name contains invalid characters.";
  return undefined;
}

export const folderNameSchema = z
  .string()
  .superRefine((value, ctx) => {
    const problem = folderNameProblem(value);
    if (problem !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  })
  .describe(
    `The subfolder's name. 1 to ${MAX_FOLDER_NAME_LENGTH} characters after trimming. Not . or ` +
      "..; no trailing period, no / or \\, no < or >, no control characters. Compared without " +
      "regard to case: a name a file or subfolder already holds in the same parent is refused " +
      "with folder_name_conflict.",
  );

export const folderDescriptionSchema = z
  .string()
  .trim()
  .max(MAX_FOLDER_DESCRIPTION_LENGTH)
  .refine(
    (value) => !CONTROL_CHAR_EXCEPT_WHITESPACE_RE.test(value),
    "description must not contain control characters",
  )
  .describe(
    `Free-text note about the subfolder. Up to ${MAX_FOLDER_DESCRIPTION_LENGTH} characters.`,
  );
