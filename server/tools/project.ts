/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";
import { STATUS_STABLE } from "@/lib/constants";
import { workspaceManager, type WorkspaceContext } from "@/lib/workspaces";

const rebindParameter = z.boolean().optional().default(false)
  .describe("Set true to move this workspace's binding away from a project it already owns. Leave false: the refusal tells agents sharing a connection that they forgot their own workspace_id.");

/** Silent rebinding would redirect another agent's later edits into this project. */
function assertRebindAllowed(workspace: WorkspaceContext | undefined, rebind: boolean, nextProjectId?: string): void {
  if (!workspace || rebind) return;
  const currentId = workspace.getProjectId();
  if (!currentId || currentId === nextProjectId) return;
  const current = ModelProject.all.find((project) => project.uuid === currentId);
  if (!current) return;
  throw new Error(
    `Workspace "${workspace.workspaceId}" is already bound to project "${current.name}" (${currentId}). ` +
    "If you are a different agent sharing this MCP connection, choose your own unique workspace_id and pass it on every call. " +
    "To switch this workspace to another project on purpose, call again with rebind: true."
  );
}

export const createProjectParameters = z.object({
  name: z.string(),
  format: z
    .string()
    .default("bedrock_block")
    .describe("Project format ID from Blockbench's Formats registry."),
  rebind: rebindParameter,
});

export const getProjectInfoParameters = z.object({});
export const selectProjectParameters = z.object({
  project_id: z.string().min(1).describe("UUID of an open project returned by list_projects. Must be unclaimed or owned by this workspace."),
  rebind: rebindParameter,
});
export const listProjectsParameters = z.object({});
export const closeProjectParameters = z.object({
  project_id: z.string().min(1).optional()
    .describe("UUID of a project owned by this workspace. Defaults to the workspace's bound project."),
  discard_unsaved: z.boolean().optional().default(false)
    .describe("Close even if the project has unsaved changes. Export the model first (export_model); closing discards the in-editor copy."),
});

export const projectToolDocs: ToolSpec[] = [
  {
    name: "create_project",
    description: "Creates a new project and binds it to this session's workspace. Agents sharing one connection must pass their unique workspace_id on every call. Every project is a Blockbench tab that stays open until closed: call close_project when you are finished with it.",
    annotations: {
      title: "Create Project",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: createProjectParameters,
    status: STATUS_STABLE,
  },
  {
    name: "get_project_info",
    description:
      "Returns read-only project orientation: format id and display name, project name/UUID, texture resolution (texture_width/height), element counts, and a summary of top-level groups. Prefer this over `risky_eval` for first-look inspection — no JavaScript execution required.",
    annotations: {
      title: "Get Project Info",
      readOnlyHint: true,
    },
    parameters: getProjectInfoParameters,
    status: STATUS_STABLE,
  },
  {
    name: "select_project",
    description: "Binds an existing open project to this workspace. Projects owned by another workspace cannot be selected. Use this to resume after reconnecting.",
    annotations: { title: "Select Project", destructiveHint: false },
    parameters: selectProjectParameters,
    status: STATUS_STABLE,
  },
  {
    name: "list_projects",
    description: "Lists open projects available to this workspace, including its owned projects and unclaimed projects. Use select_project with a returned UUID to resume work.",
    annotations: { title: "List Projects", readOnlyHint: true },
    parameters: listProjectsParameters,
    status: STATUS_STABLE,
  },
  {
    name: "close_project",
    description: "Closes a project tab this workspace created or selected, freeing its memory, and unbinds it from the workspace. Projects opened by the user or owned by other workspaces cannot be closed. Unsaved projects are refused unless discard_unsaved is true, so export the model first.",
    annotations: { title: "Close Project", destructiveHint: true },
    parameters: closeProjectParameters,
    status: STATUS_STABLE,
  },
];

export function registerProjectTools() {
  createTool(projectToolDocs[0].name, {
    ...projectToolDocs[0],
    async execute({ name, format, rebind }, context) {
      if (!Formats[format]) throw new Error(`Unknown project format: ${format}`);
      assertRebindAllowed(context?.workspace, rebind);
      const created = newProject(Formats[format]);

      if (!created) {
        throw new Error("Failed to create project.");
      }

      Project!.name = name;
      context?.workspace?.bindProject(Project!.uuid);

      return `Created project with name "${name}" (UUID: ${Project?.uuid}) and format "${format}".`;
    },
  }, projectToolDocs[0].status);

  createTool(projectToolDocs[1].name, {
    ...projectToolDocs[1],
    async execute() {
      if (!Project) {
        throw new Error(
          "No project is open. Use create_project to start a new one, or open an existing file in Blockbench."
        );
      }

      const format = Format as { id?: string; name?: string; display_name?: string } | undefined;

      const rootGroups = Outliner.root
        .filter((n): n is Group => n instanceof Group)
        .map((g) => ({
          name: g.name,
          uuid: g.uuid,
          children: g.children?.length ?? 0,
        }));

      return JSON.stringify(
        {
          project: {
            name: Project.name,
            uuid: Project.uuid,
            save_path: (Project as { save_path?: string }).save_path ?? null,
          },
          format: {
            id: format?.id ?? null,
            name: format?.display_name ?? format?.name ?? null,
          },
          resolution: {
            texture_width: Project.texture_width ?? null,
            texture_height: Project.texture_height ?? null,
          },
          counts: {
            cubes: Cube.all.length,
            meshes: Mesh.all.length,
            groups: Group.all.length,
            textures: Texture.all.length,
            outliner_elements: Outliner.elements.length,
          },
          root_groups: rootGroups,
        },
        null,
        2
      );
    },
  }, projectToolDocs[1].status);

  createTool(projectToolDocs[2].name, {
    ...projectToolDocs[2],
    async execute({ project_id, rebind }, context) {
      if (!context?.workspace) throw new Error("select_project requires an MCP workspace.");
      // Report ownership conflicts first: they mean "pick another project", not "rebind".
      workspaceManager.assertProjectAccess(project_id);
      assertRebindAllowed(context.workspace, rebind, project_id);
      context.workspace.bindProject(project_id);
      return JSON.stringify({ project_id, workspace_id: context.workspace.workspaceId });
    },
  }, projectToolDocs[2].status);

  createTool(projectToolDocs[3].name, {
    ...projectToolDocs[3],
    async execute(_args, context) {
      const workspace = context?.workspace;
      return JSON.stringify(workspaceManager.getProjects().map(project => ({
        uuid: project.uuid, name: project.name, format: project.format?.id, saved: project.saved,
        owned: workspace?.ownsProject(project.uuid) ?? false,
      })));
    },
  }, projectToolDocs[3].status);

  createTool(projectToolDocs[4].name, {
    ...projectToolDocs[4],
    async execute({ project_id, discard_unsaved }, context) {
      const workspace = context?.workspace;
      if (!workspace) throw new Error("close_project requires an MCP workspace.");
      const uuid = project_id ?? workspace.getProjectId();
      if (!uuid) {
        throw new Error("This workspace is not bound to a project. Pass the project_id of a project this workspace owns (see list_projects).");
      }
      if (!workspace.ownsProject(uuid)) {
        throw new Error("Only projects created or selected by this workspace can be closed. Tabs opened by the user or owned by other workspaces are left open.");
      }
      const project = ModelProject.all.find((candidate) => candidate.uuid === uuid);
      if (!project) {
        workspace.releaseProject(uuid);
        return JSON.stringify({ closed: uuid, already_closed: true, workspace_id: workspace.workspaceId });
      }
      if (!project.saved && !discard_unsaved) {
        throw new Error(
          `Project "${project.name}" has unsaved changes. Export the model first (export_model), ` +
          "then call close_project again with discard_unsaved: true."
        );
      }
      // Forced: the unsaved check above replaces Blockbench's blocking save dialog.
      const closed = await project.close(true);
      if (closed === false || ModelProject.all.includes(project)) {
        throw new Error(`Blockbench did not close project "${project.name}". Finish any open dialog in Blockbench and retry.`);
      }
      workspace.releaseProject(uuid);
      return JSON.stringify({ closed: uuid, name: project.name, workspace_id: workspace.workspaceId });
    },
  }, projectToolDocs[4].status);
}
