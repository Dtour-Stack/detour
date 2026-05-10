import type { Action, ActionResult } from "@elizaos/core";
import { CODING_TOOLS_CONTEXTS } from "../types.js";
import { editAction } from "./edit.js";
import { readAction } from "./read.js";
import { writeAction } from "./write.js";

export const fileAction: Action = {
  name: "FILE",
  contexts: [...CODING_TOOLS_CONTEXTS],
  description:
    "File operations: read, write, or edit a file at an absolute path. " +
    "Sub-actions: READ (read file contents), WRITE (write full file contents), EDIT (replace a string within a file).",
  descriptionCompressed: "File read/write/edit at absolute path.",
  similes: ["READ_FILE", "WRITE_FILE", "EDIT_FILE", "FILE_OPERATION", "FILE_IO"],
  // `subActions` + `subPlanner` are eliza/core@develop fields not yet
  // in detour's pinned core. Cast through unknown so build stays clean
  // against the older type def; runtime ignores unknown fields anyway.
  ...({ subActions: [readAction, writeAction, editAction] } as unknown as Record<string, unknown>),
  ...({ subPlanner: {
    name: "file_subplanner",
    description: "Select READ, WRITE, or EDIT based on the file operation the user is requesting.",
  } } as unknown as Record<string, unknown>),
  parameters: [],
  examples: [],
  validate: async () => true,
  handler: async (): Promise<ActionResult> => ({
    success: true,
    text: "File operation routed to the selected sub-action.",
    data: { actionName: "FILE", subActions: ["READ", "WRITE", "EDIT"] },
  }),
};
