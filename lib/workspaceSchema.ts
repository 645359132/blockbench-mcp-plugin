import { z } from "zod";

/** Shared by runtime registration and generated documentation. */
export const workspaceIdParameter = z.string().min(1).max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/)
  .optional()
  .describe("Workspace within this MCP session (default: default). Agents sharing a connection must each choose a unique ID and pass it on EVERY tool call, including create_project.");

export function withWorkspaceParameter(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) return schema.extend({ workspace_id: workspaceIdParameter });
  // Object refinements are enforced at execution time; documentation shows their fields.
  if (schema instanceof z.ZodEffects) return withWorkspaceParameter(schema.innerType());
  return z.intersection(schema, z.object({ workspace_id: workspaceIdParameter }));
}
