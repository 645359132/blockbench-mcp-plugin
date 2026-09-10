import { z } from "zod";
import type { IMCPTool, IMCPPrompt, IMCPResource, StatusType } from "@/types";
import { getServer } from "@/server/server";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { workspaceManager, type WorkspaceContext } from "@/lib/workspaces";
import { workspaceIdParameter } from "@/lib/workspaceSchema";
import { sessionManager } from "@/lib/sessions";

/**
 * Declarative tool spec for documentation and registration.
 * Contains everything except the `execute` implementation.
 */
export interface ToolSpec {
  name: string;
  description: string;
  annotations?: {
    title?: string;
    destructiveHint?: boolean;
    readOnlyHint?: boolean;
    openWorldHint?: boolean;
  };
  parameters: z.ZodType;
  status: StatusType;
}

/**
 * Declarative prompt spec for documentation and registration.
 */
export interface PromptSpec {
  name: string;
  description: string;
  title?: string;
  argsSchema?: z.ZodObject<z.ZodRawShape>;
  status: StatusType;
}

/**
 * Declarative resource spec for documentation and registration.
 */
export interface ResourceSpec {
  name: string;
  description: string;
  uriTemplate: string;
  title?: string;
}

/**
 * User-visible list of tool details.
 */
export const tools: Record<string, IMCPTool> = {};

/**
 * User-visible list of prompt details.
 */
export const prompts: Record<string, IMCPPrompt> = {};

/**
 * User-visible list of resource details.
 */
export const resources: Record<string, IMCPResource> = {};

export interface ToolContext {
  reportProgress: (progress: { progress: number; total: number }) => void;
  workspace?: WorkspaceContext;
}

interface TextContent {
  type: "text";
  text: string;
}

interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

type ToolContentItem = TextContent | ImageContent;

type ToolResult = string | { content: ToolContentItem[]; structuredContent?: unknown };

interface ToolDefinition {
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  parameters: z.ZodType;
  outputSchema?: Record<string, z.ZodType> | z.ZodType;
  execute: (args: Record<string, unknown>, context?: ToolContext) => Promise<ToolResult>;
  annotations?: {
    title?: string;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
    readOnlyHint?: boolean;
  };
}

/**
 * Store tool definitions for dynamic server reconstruction
 */
const toolDefinitions: Record<string, ToolDefinition> = {};

interface RequestContext {
  sessionId?: string;
  signal?: AbortSignal;
  _meta?: Record<string, unknown>;
}

interface ToolRegistrar {
  registerTool: (
    toolName: string,
    definition: Pick<ToolDefinition, "title" | "description" | "inputSchema" | "annotations">,
    callback: (args: unknown, extra: unknown) => Promise<unknown>
  ) => void;
}

const globalTools = new Set([
  "risky_eval", "trigger_action", "emulate_clicks", "fill_dialog",
  "create_brush_preset", "load_brush_preset",
  "import_texture_set",
]);

function requestWorkspace(extra: RequestContext, explicit?: unknown): string {
  return workspaceIdParameter.parse(explicit ?? extra._meta?.["blockbench/workspace_id"]) ?? "default";
}

async function runInWorkspace<T>(
  extra: RequestContext,
  workspaceId: string,
  requireProject: boolean,
  operation: (workspace?: WorkspaceContext) => Promise<T>
): Promise<T> {
  if (!extra.sessionId) {
    // The reference server is used by local UI tests only, never by HTTP clients.
    return operation();
  }
  const endActivity = sessionManager.beginActivity(extra.sessionId);
  try {
    return await workspaceManager.run({
      sessionId: extra.sessionId, workspaceId, requireProject, signal: extra.signal,
    }, operation);
  } finally {
    endActivity();
  }
}

async function executeTool(name: string, definition: ToolDefinition, args: unknown, extra: RequestContext = {}) {
  const input = args as Record<string, unknown>;
  const workspaceId = requestWorkspace(extra, input.workspace_id);
  // Parse the full schema as well: extracting its shape alone loses object refinements.
  const parameters = await definition.parameters.parseAsync(input);
  return runInWorkspace(extra, workspaceId, !["create_project", "select_project", "list_projects"].includes(name), async workspace => {
    if (workspace && name === "animation_timeline" && parameters.action === "play") {
      throw new Error("Continuous playback cannot outlive an isolated tool call. Set a timeline time and capture a frame, or preview playback manually in Blockbench.");
    }
    if (workspace && globalTools.has(name)) {
      if (typeof Settings === "undefined" || Settings.get("mcp_allow_global_tools") !== true) {
        throw new Error("Global editor tools are disabled for isolated modeling. Use the structured modeling tools, or enable MCP global editor tools in Blockbench for a single workspace.");
      }
      workspaceManager.assertExclusive();
    }
    if (workspace && name === "capture_screenshot" && parameters.project !== undefined) {
      const project = ModelProject.all.find(p => p.uuid === parameters.project || p.name === parameters.project);
      if (!project || project.uuid !== workspace.getProjectId()) {
        throw new Error("Capture the project bound to this workspace. Use select_project to change its binding first.");
      }
    }
    const result = await definition.execute(parameters, { reportProgress: () => {}, workspace });
    return typeof result === "string" ? { content: [{ type: "text" as const, text: result }] } : result;
  });
}

/**
 * Extracts the shape from a Zod schema, unwrapping ZodEffects if necessary.
 * Uses _def.typeName for reliable type checking across different Zod instances.
 */
function extractShape(schema: z.ZodType): Record<string, z.ZodType> {
  const def = schema._def as { typeName?: string; schema?: z.ZodType; shape?: () => Record<string, z.ZodType> };
  
  if (def.typeName === "ZodObject") {
    return def.shape?.() ?? {};
  }
  
  if (def.typeName === "ZodEffects" && def.schema) {
    return extractShape(def.schema);
  }
  
  return {};
}

/**
 * Creates a new MCP tool and registers it with the server using the official SDK.
 * @param name - The tool name suffix (will be prefixed with "blockbench_").
 * @param tool - The tool configuration.
 * @param tool.description - The description of the tool.
 * @param tool.annotations - Annotations for the tool (title, hints).
 * @param tool.parameters - Zod schema for input parameters (supports ZodObject or ZodEffects from .refine()).
 * @param tool.execute - The async function to execute when the tool is called.
 * @param status - The status of the tool (stable, experimental, deprecated).
 * @param enabled - Whether the tool is enabled.
 * @returns - The created tool metadata.
 * @throws - If a tool with the same name already exists.
 */
export function createTool<T extends z.ZodType>(
  name: string,
  tool: {
    description: string;
    annotations?: {
      title?: string;
      destructiveHint?: boolean;
      openWorldHint?: boolean;
      readOnlyHint?: boolean;
    };
    parameters: T;
    execute: (args: z.infer<T>, context?: ToolContext) => Promise<ToolResult>;
  },
  status: IMCPTool["status"] = "stable",
  enabled: boolean = true
) {
  if (tools[name]) {
    throw new Error(`Tool with name "${name}" already exists.`);
  }

  const inputSchema = { ...extractShape(tool.parameters), workspace_id: workspaceIdParameter };

  const toolDef: ToolDefinition = {
    title: tool.annotations?.title ?? tool.description,
    description: tool.description,
    inputSchema,
    parameters: tool.parameters,
    execute: tool.execute,
    annotations: tool.annotations,
  };

  // Store tool definition
  toolDefinitions[name] = toolDef;

  // Register with server if enabled
  if (enabled) {
    const server = getServer();

    const registerTool = (server as unknown as ToolRegistrar).registerTool.bind(server);

    registerTool(
      name,
      {
        title: toolDef.title,
        description: toolDef.description,
        inputSchema,
        annotations: toolDef.annotations,
      },
      (args, extra) => executeTool(name, toolDef, args, extra as RequestContext)
    );
  }

  tools[name] = {
    name,
    description: toolDef.title,
    enabled,
    status,
  };

  return tools[name];
}

/**
 * Gets all tool definitions for server reconstruction
 */
export function getAllToolDefinitions() {
  return toolDefinitions;
}

/**
 * Gets enabled tool definitions for server reconstruction
 */
export function getEnabledToolDefinitions() {
  return Object.fromEntries(
    Object.entries(toolDefinitions).filter(([name]) => tools[name]?.enabled)
  );
}

/**
 * Registers all enabled tools on a server instance
 * Used to set up new session servers with the same tools
 */
export function registerToolsOnServer(server: unknown) {
  const enabledDefs = getEnabledToolDefinitions();

  const typedServer = server as ToolRegistrar;

  for (const [name, toolDef] of Object.entries(enabledDefs)) {
    typedServer.registerTool(
      name,
      {
        title: toolDef.title,
        description: toolDef.description,
        inputSchema: toolDef.inputSchema,
        annotations: toolDef.annotations,
      },
      (args, extra) => executeTool(name, toolDef, args, extra as RequestContext)
    );
  }
}

/**
 * Resource definition storage for dynamic server reconstruction
 */
interface ResourceDefinition {
  name: string;
  uriTemplate: string;
  metadata: {
    title?: string;
    description?: string;
  };
  listCallback?: () => Promise<{
    resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
  }>;
  readCallback: (
    uri: URL,
    variables: Record<string, string>
  ) => Promise<{
    contents: Array<{ uri: string; text: string; mimeType?: string } | { uri: string; blob: string; mimeType?: string }>;
  }>;
}

const resourceDefinitions: Record<string, ResourceDefinition> = {};

/**
 * Creates a new MCP resource and registers it with the server using the official SDK.
 * @param name - The resource name.
 * @param config - The resource configuration.
 * @param config.uriTemplate - The URI template pattern (e.g., "nodes://{id}").
 * @param config.title - Optional title for the resource.
 * @param config.description - The description of the resource.
 * @param config.listCallback - Optional async function to list available resources.
 * @param config.readCallback - Async function to read the resource.
 * @returns - The created resource metadata.
 */
export function createResource(
  name: string,
  config: {
    uriTemplate: string;
    title?: string;
    description: string;
    listCallback?: () => Promise<{
      resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
    }>;
    readCallback: (
      uri: URL,
      variables: Record<string, string>
    ) => Promise<{
      contents: Array<{ uri: string; text: string; mimeType?: string } | { uri: string; blob: string; mimeType?: string }>;
    }>;
  }
) {
  if (resources[name]) {
    throw new Error(`Resource with name "${name}" already exists.`);
  }

  const resourceDef: ResourceDefinition = {
    name,
    uriTemplate: config.uriTemplate,
    metadata: {
      title: config.title,
      description: config.description,
    },
    listCallback: config.listCallback,
    readCallback: config.readCallback,
  };

  // Store resource definition for session reconstruction
  resourceDefinitions[name] = resourceDef;

  // Register with the current server instance
  // Use ResourceTemplate to enable dynamic resource listing via listCallback
  const server = getServer();

  const registerResource = (
    server as unknown as {
      registerResource: (
        resourceName: string,
        uriOrTemplate: ResourceTemplate,
        metadata: {
          title?: string;
          description?: string;
        },
        readCallback: (
          uri: URL,
          variables: Record<string, string | string[]>
        ) => Promise<{
          contents: Array<{ uri: string; text: string; mimeType?: string } | { uri: string; blob: string; mimeType?: string }>;
        }>
      ) => void;
    }
  ).registerResource.bind(server);

  registerResource(
    name,
    new ResourceTemplate(config.uriTemplate, { list: config.listCallback }),
    {
      title: config.title,
      description: config.description,
    },
    async (uri: URL, variables: Record<string, string | string[]>) => {
      const normalizedVariables = Object.fromEntries(
        Object.entries(variables).map(([key, value]) => {
          if (Array.isArray(value)) {
            return [key, value[0] ?? ""];
          }
          return [key, value];
        })
      ) as Record<string, string>;

      return config.readCallback(uri, normalizedVariables);
    }
  );

  resources[name] = {
    name,
    description: config.description,
    uriTemplate: config.uriTemplate,
  };

  return resources[name];
}

/**
 * Gets all resource definitions for server reconstruction
 */
export function getAllResourceDefinitions() {
  return resourceDefinitions;
}

/**
 * Registers all resources on a server instance
 * Used to set up new session servers with the same resources
 */
export function registerResourcesOnServer(server: unknown) {
  const typedServer = server as {
    registerResource: (
      resourceName: string,
      uriOrTemplate: ResourceTemplate,
      metadata: {
        title?: string;
        description?: string;
      },
      readCallback: (
        uri: URL,
        variables: Record<string, string | string[]>,
        extra: RequestContext
      ) => Promise<{
        contents: Array<{ uri: string; text: string; mimeType?: string } | { uri: string; blob: string; mimeType?: string }>;
      }>
    ) => void;
  };

  for (const [name, resourceDef] of Object.entries(resourceDefinitions)) {
    typedServer.registerResource(
      name,
      new ResourceTemplate(resourceDef.uriTemplate, {
        list: resourceDef.listCallback ? (extra) => runInWorkspace(
          extra, requestWorkspace(extra), false, async () => resourceDef.listCallback!()
        ) : undefined,
      }),
      resourceDef.metadata,
      async (uri: URL, variables: Record<string, string | string[]>, extra: RequestContext) => {
        const normalizedVariables = Object.fromEntries(
          Object.entries(variables).map(([key, value]) => {
            if (Array.isArray(value)) {
              return [key, value[0] ?? ""];
            }
            return [key, value];
          })
        ) as Record<string, string>;

        return runInWorkspace(extra, requestWorkspace(extra), false,
          async () => resourceDef.readCallback(uri, normalizedVariables));
      }
    );
  }
}

/**
 * Prompt definition storage for dynamic server reconstruction
 */
interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  argsSchema?: Record<string, z.ZodType>;
  generate: (args: Record<string, unknown>) => Promise<{
    messages: Array<{
      role: "user" | "assistant";
      content: { type: string; text: string };
    }>;
  }>;
}

const promptDefinitions: Record<string, PromptDefinition> = {};

/**
 * Creates a new MCP prompt and registers it with the server using the official SDK.
 * @param name - The prompt name
 * @param prompt - The prompt configuration.
 * @param prompt.description - The description of the prompt.
 * @param prompt.arguments - Zod schema for prompt arguments.
 * @param prompt.generate - Function to generate prompt messages from arguments.
 * @param status - The status of the prompt.
 * @param enabled - Whether the prompt is enabled.
 * @returns - The created prompt metadata.
 * @throws - If a prompt with the same name already exists.
 */
export function createPrompt<T extends z.ZodRawShape = Record<string, never>>(
  name: string,
  prompt: {
    title?: string;
    description: string;
    argsSchema?: z.ZodObject<T>;
    generate?: (
      args: z.infer<z.ZodObject<T>>
    ) =>
      | {
      messages: Array<{
        role: "user" | "assistant";
        content: { type: string; text: string };
      }>;
    }
      | Promise<{
          messages: Array<{
            role: "user" | "assistant";
            content: { type: string; text: string };
          }>;
        }>;
  },
  status: IMCPPrompt["status"] = "stable",
  enabled: boolean = true
) {
  if (prompts[name]) {
    throw new Error(`Prompt with name "${name}" already exists.`);
  }

  // Store prompt definition for session reconstruction
  if (enabled && prompt.generate && prompt.argsSchema) {
    const promptDef: PromptDefinition = {
      name,
      title: prompt.title || prompt.description,
      description: prompt.description,
      argsSchema: prompt.argsSchema.shape,
      generate: async (args: Record<string, unknown>) => {
        const result = await prompt.generate!(args as z.infer<z.ZodObject<T>>);
        return result;
      },
    };

    promptDefinitions[name] = promptDef;

    // Register with the singleton server
    getServer().registerPrompt(
      name,
      {
        title: promptDef.title,
        description: promptDef.description,
        argsSchema: promptDef.argsSchema,
      },
      promptDef.generate
    );
  }

  prompts[name] = {
    name,
    arguments: prompt.argsSchema?.shape || {},
    description: prompt.description,
    enabled,
    status,
  };

  return prompts[name];
}

/**
 * Gets all prompt definitions for server reconstruction
 */
export function getAllPromptDefinitions() {
  return promptDefinitions;
}

/**
 * Registers all prompts on a server instance
 * Used to set up new session servers with the same prompts
 */
export function registerPromptsOnServer(server: unknown) {
  const typedServer = server as {
    registerPrompt: (
      promptName: string,
      definition: {
        title: string;
        description: string;
        argsSchema?: Record<string, z.ZodType>;
      },
      callback: (args: Record<string, unknown>) => Promise<{
        messages: Array<{
          role: "user" | "assistant";
          content: { type: string; text: string };
        }>;
      }>
    ) => void;
  };

  for (const [name, promptDef] of Object.entries(promptDefinitions)) {
    typedServer.registerPrompt(
      name,
      {
        title: promptDef.title,
        description: promptDef.description,
        argsSchema: promptDef.argsSchema,
      },
      promptDef.generate
    );
  }
}
