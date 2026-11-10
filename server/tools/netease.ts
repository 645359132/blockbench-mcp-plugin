/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";
import { STATUS_EXPERIMENTAL } from "@/lib/constants";
import { elementIdSchema, meshIdSchema } from "@/lib/zodObjects";
import { findMeshOrThrow } from "@/lib/util";
import {
  compileNeteaseResourcePack,
  findTextureOwners,
  validateNeteaseInterchange,
  type NeteaseModelMetadata,
} from "@/lib/netease/exporter";
import { captureNeteaseProject } from "@/lib/netease/blockbench-export";
import {
  DEFAULT_NETEASE_VALIDATION_OPTIONS,
  validateNeteaseProject,
  type NeteaseArmatureSnapshot,
  type NeteaseMeshSnapshot,
  type NeteaseProjectSnapshot,
  type NeteaseValidationOptions,
} from "@/lib/netease/validator";

export const neteaseGetFormatInfoParameters = z.object({});

export const neteaseValidateModelParameters = z.object({
  strict_rigid_skinning: z
    .boolean()
    .optional()
    .default(DEFAULT_NETEASE_VALIDATION_OPTIONS.strictRigidSkinning)
    .describe("Require every vertex to be assigned to exactly one bone."),
  recommended_max_vertices: z
    .number()
    .int()
    .positive()
    .optional()
    .default(DEFAULT_NETEASE_VALIDATION_OPTIONS.recommendedMaxVertices),
  hard_max_vertices: z
    .number()
    .int()
    .positive()
    .optional()
    .default(DEFAULT_NETEASE_VALIDATION_OPTIONS.hardMaxVertices),
  enforce_vertex_hard_limit: z
    .boolean()
    .optional()
    .default(DEFAULT_NETEASE_VALIDATION_OPTIONS.hardVertexLimitIsError)
    .describe("Treat hard_max_vertices as an error. Disabled by default because observed NetEase effect models can be much larger."),
  recommended_max_bones: z
    .number()
    .int()
    .positive()
    .optional()
    .default(DEFAULT_NETEASE_VALIDATION_OPTIONS.recommendedMaxBones),
  hard_max_bones: z
    .number()
    .int()
    .positive()
    .optional()
    .default(DEFAULT_NETEASE_VALIDATION_OPTIONS.hardMaxBones),
  max_textures: z
    .number()
    .int()
    .positive()
    .optional()
    .default(DEFAULT_NETEASE_VALIDATION_OPTIONS.maxTextures),
});

export const neteaseAssignRigidWeightsParameters = z.object({
  mesh_id: meshIdSchema,
  bone_id: elementIdSchema.describe("UUID or name of a bone in the mesh's armature."),
  vertices: z
    .array(z.string())
    .min(1)
    .optional()
    .describe("Vertex keys to assign. If omitted, assigns every vertex in the mesh."),
  clear_other_bones: z
    .boolean()
    .optional()
    .default(true)
    .describe("Remove the selected vertices from every other bone before assigning weight 1."),
});

const neteaseNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "Use lowercase ASCII letters, digits, and underscores; start with a letter.");

export const neteaseExportResourcePackParameters = z.object({
  model_name: neteaseNameSchema.describe("Model identifier used in filenames and netease_models.json."),
  output_path: z
    .string()
    .min(1)
    .describe("Absolute path to the resource-pack root. Files are written below models/ and textures/models/."),
  armature_id: z.string().optional().describe("Armature UUID or name. Required when multiple exported armatures exist."),
  centimeters_per_unit: z
    .number()
    .positive()
    .optional()
    .default(1)
    .describe("Scale applied to Blockbench coordinates. Blockbench axes already match the NetEase Y-up model space."),
  include_animations: z.boolean().optional().default(true),
  animation_ids: z
    .array(z.string())
    .optional()
    .describe("Animation UUIDs, full names, or short names to export. Omit to export all armature animations."),
  material: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .default("entity_for_skeleton")
    .describe("NetEase render material or ordered multi-pass material list."),
  material_cpu: z.union([z.string(), z.array(z.string())]).optional(),
  texture: z
    .object({
      tex0: neteaseNameSchema.optional(),
      tex1: neteaseNameSchema.optional(),
      tex2: neteaseNameSchema.optional(),
      tex3: neteaseNameSchema.optional(),
    })
    .optional()
    .describe("Optional texture overrides below textures/models, without file extensions."),
  arm_model: neteaseNameSchema.optional(),
  use_split_meshes: z.boolean().optional().default(false),
  split_bones_group: z.record(z.unknown()).optional(),
  dy_load: z.boolean().optional().default(true),
  copy_textures: z.boolean().optional().default(true),
  compact: z.boolean().optional().default(false),
});

export const neteaseToolDocs: ToolSpec[] = [
  {
    name: "netease_get_format_info",
    description:
      "Reports whether the current Blockbench project has the mesh and armature features needed for NetEase skeletal-model authoring. This does not claim runtime-format compatibility.",
    annotations: { title: "NetEase Format Readiness", readOnlyHint: true },
    parameters: neteaseGetFormatInfoParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "netease_validate_model",
    description:
      "Validates the current polygon mesh, armature, textures and vertex weights against a conservative NetEase skeletal-model authoring profile. It validates source readiness, not converted runtime JSON.",
    annotations: { title: "Validate NetEase Source Model", readOnlyHint: true },
    parameters: neteaseValidateModelParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "netease_assign_rigid_weights",
    description:
      "Assigns selected mesh vertices to one armature bone with weight 1, optionally clearing all other bone influences. This matches the conservative rigid-skinning profile.",
    annotations: { title: "Assign NetEase Rigid Weights", destructiveHint: true },
    parameters: neteaseAssignRigidWeightsParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "netease_export_resource_pack",
    description:
      "Exports the selected Blockbench armature as NetEase China Edition mesh, skeleton, animation, registry, interchange, and texture files. Animations require numeric linear keyframes with one data point and rotation steps of at most 180 degrees per axis. Existing netease_models.json entries are preserved.",
    annotations: {
      title: "Export NetEase Resource Pack",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: neteaseExportResourcePackParameters,
    status: STATUS_EXPERIMENTAL,
  },
];

function captureProjectSnapshot(): NeteaseProjectSnapshot {
  const armatures: NeteaseArmatureSnapshot[] = Armature.all.map((armature) => ({
    id: armature.uuid,
    name: armature.name,
    boneNames: armature.getAllBones().map((bone: ArmatureBone) => bone.name),
  }));

  const meshes: NeteaseMeshSnapshot[] = Mesh.all.map((mesh) => {
    const armature = mesh.getArmature?.();
    const bones = armature?.getAllBones?.() ?? [];
    const textureIds = new Set<string>();

    for (const face of Object.values(mesh.faces)) {
      if (face.texture) textureIds.add(String(face.texture));
    }

    return {
      id: mesh.uuid,
      name: mesh.name,
      armatureId: armature?.uuid ?? null,
      vertices: Object.keys(mesh.vertices).map((key) => ({
        key,
        weights: bones.flatMap((bone: ArmatureBone) => {
          const weight = bone.getVertexWeight(mesh, key);
          return weight > 0
            ? [{ boneId: bone.uuid, boneName: bone.name, weight }]
            : [];
        }),
      })),
      faceVertexCounts: Object.values(mesh.faces).map((face) => face.vertices.length),
      textureIds: [...textureIds],
    };
  });

  const format = Format as (ModelFormat & {
    meshes?: boolean;
    armature_rig?: boolean;
  }) | undefined;

  return {
    formatId: format?.id ?? null,
    formatSupportsMeshes: Boolean(format?.meshes),
    formatSupportsArmatures: Boolean(format?.armature_rig),
    projectTextureCount: Texture.all.length,
    meshes,
    armatures,
  };
}

export function registerNeteaseTools(): void {
  createTool(neteaseToolDocs[0].name, {
    ...neteaseToolDocs[0],
    async execute() {
      if (!Project) throw new Error("No project is open.");
      const snapshot = captureProjectSnapshot();
      return JSON.stringify(
        {
          format_id: snapshot.formatId,
          supports_meshes: snapshot.formatSupportsMeshes,
          supports_armatures: snapshot.formatSupportsArmatures,
          source_authoring_ready:
            snapshot.formatSupportsMeshes && snapshot.formatSupportsArmatures,
          runtime_export_supported: true,
          runtime_export_note:
            "The MCP can write observed NetEase mesh/skeleton/animation JSON and registry files. Final compatibility must still be checked in the current China Edition developer editor because NetEase does not publish a formal schema.",
          counts: {
            meshes: snapshot.meshes.length,
            armatures: snapshot.armatures.length,
            textures: snapshot.projectTextureCount,
          },
        },
        null,
        2
      );
    },
  }, neteaseToolDocs[0].status);

  createTool(neteaseToolDocs[1].name, {
    ...neteaseToolDocs[1],
    async execute(args) {
      if (!Project) throw new Error("No project is open.");
      if (args.hard_max_vertices < args.recommended_max_vertices) {
        throw new Error("hard_max_vertices must be greater than or equal to recommended_max_vertices.");
      }
      if (args.hard_max_bones < args.recommended_max_bones) {
        throw new Error("hard_max_bones must be greater than or equal to recommended_max_bones.");
      }

      const options: NeteaseValidationOptions = {
        strictRigidSkinning: args.strict_rigid_skinning,
        recommendedMaxVertices: args.recommended_max_vertices,
        hardMaxVertices: args.hard_max_vertices,
        hardVertexLimitIsError: args.enforce_vertex_hard_limit,
        recommendedMaxBones: args.recommended_max_bones,
        hardMaxBones: args.hard_max_bones,
        maxTextures: args.max_textures,
      };
      const result = validateNeteaseProject(captureProjectSnapshot(), options);
      return JSON.stringify(
        {
          profile: {
            name: "conservative_netease_skeletal_source",
            ...options,
          },
          scope: "Blockbench source model; official conversion output is not validated",
          ...result,
        },
        null,
        2
      );
    },
  }, neteaseToolDocs[1].status);

  createTool(neteaseToolDocs[2].name, {
    ...neteaseToolDocs[2],
    async execute({ mesh_id, bone_id, vertices, clear_other_bones }) {
      const mesh = findMeshOrThrow(mesh_id);
      const armature = mesh.getArmature?.();
      if (!armature) {
        throw new Error(
          `Mesh "${mesh.name}" is not attached to an armature. Use bind_mesh_to_armature first.`
        );
      }

      const bone = ArmatureBone.all.find(
        (candidate) =>
          candidate.uuid === bone_id ||
          candidate.name === bone_id ||
          candidate.uuid.startsWith(bone_id)
      );
      if (!bone) throw new Error(`Armature bone not found: ${bone_id}`);
      if (bone.getArmature()?.uuid !== armature.uuid) {
        throw new Error(
          `Bone "${bone.name}" does not belong to mesh "${mesh.name}" armature "${armature.name}".`
        );
      }

      const vertexKeys = vertices ?? Object.keys(mesh.vertices);
      const missing = vertexKeys.filter((key: string) => !(key in mesh.vertices));
      if (missing.length > 0) {
        throw new Error(
          `Mesh "${mesh.name}" does not contain vertex key(s): ${missing.join(", ")}`
        );
      }

      const bones = armature.getAllBones();
      Undo.initEdit({ elements: [mesh, ...bones] });
      for (const vertexKey of vertexKeys) {
        if (clear_other_bones) {
          for (const otherBone of bones) {
            if (otherBone.uuid !== bone.uuid) {
              otherBone.setVertexWeight(mesh, vertexKey, 0);
            }
          }
        }
        bone.setVertexWeight(mesh, vertexKey, 1);
      }
      Undo.finishEdit("Assign NetEase rigid weights");
      Canvas.updateView({
        elements: [mesh],
        element_aspects: { geometry: true },
      });

      return JSON.stringify(
        {
          mesh: { uuid: mesh.uuid, name: mesh.name },
          armature: { uuid: armature.uuid, name: armature.name },
          bone: { uuid: bone.uuid, name: bone.name },
          vertices_assigned: vertexKeys.length,
          weight: 1,
          cleared_other_bones: clear_other_bones,
        },
        null,
        2
      );
    },
  }, neteaseToolDocs[2].status);

  createTool(neteaseToolDocs[3].name, {
    ...neteaseToolDocs[3],
    async execute(args) {
      if (!Project) throw new Error("No project is open.");
      if (!PathModule.isAbsolute(args.output_path)) {
        throw new Error("output_path must be an absolute filesystem path.");
      }
      if (args.use_split_meshes && !args.split_bones_group) {
        throw new Error("split_bones_group is required when use_split_meshes is true.");
      }

      const model: NeteaseModelMetadata = {
        name: args.model_name,
        dy_load: args.dy_load,
        material: args.material,
        ...(args.material_cpu !== undefined ? { material_cpu: args.material_cpu } : {}),
        ...(args.texture ? { texture: args.texture } : {}),
        ...(args.arm_model ? { arm_model: args.arm_model } : {}),
        ...(args.use_split_meshes
          ? {
              useSplitMeshes: true,
              splitBonesGroup: args.split_bones_group,
            }
          : {}),
      };
      const captured = captureNeteaseProject({
        model,
        armatureId: args.armature_id,
        centimetersPerUnit: args.centimeters_per_unit,
        animationIds: args.animation_ids,
        includeAnimations: args.include_animations,
      });
      const issues = validateNeteaseInterchange(captured.document);
      const errors = issues.filter((issue) => issue.severity === "error");
      if (errors.length > 0) {
        throw new Error(
          `NetEase export validation failed:\n${errors
            .map((issue) => `${issue.code}${issue.location ? ` ${issue.location}` : ""}: ${issue.message}`)
            .join("\n")}`
        );
      }

      const fs = requireNativeModule("fs", {
        scope: args.output_path,
        message: `MCP needs access to export NetEase model "${args.model_name}" to ${args.output_path}`,
      }) as any;
      if (!fs) throw new Error("File system access was denied.");

      const outputRoot = PathModule.resolve(args.output_path);
      const registryPath = PathModule.join(outputRoot, "models", "netease_models.json");
      let existingRegistry: Record<string, unknown> = {};
      if (fs.existsSync(registryPath)) {
        const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error(`Existing registry is not a JSON object: ${registryPath}`);
        }
        existingRegistry = parsed;
      }

      const compiled = compileNeteaseResourcePack(
        captured.document,
        existingRegistry,
        args.compact
      );
      const texturePayloads: Array<{ target: string; bytes: Buffer }> = [];
      if (args.copy_textures) {
        for (const [identifier, texture] of captured.textures) {
          const target = PathModule.join(
            outputRoot,
            "textures",
            "models",
            `${identifier}.png`
          );
          const dataUrl = texture.getDataURL?.() ?? (texture as any).source;
          if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
            throw new Error(`Texture "${texture.name}" cannot be serialized as an embedded image.`);
          }
          const comma = dataUrl.indexOf(",");
          if (comma < 0) throw new Error(`Texture "${texture.name}" returned an invalid data URL.`);
          const header = dataUrl.slice(0, comma);
          const payload = dataUrl.slice(comma + 1);
          const bytes = header.includes(";base64")
            ? Buffer.from(payload, "base64")
            : Buffer.from(decodeURIComponent(payload), "utf8");
          texturePayloads.push({ target, bytes });
        }
        const owners = findTextureOwners(existingRegistry, args.model_name, (relativePath) =>
          JSON.parse(fs.readFileSync(PathModule.join(outputRoot, "models", ...relativePath.split("/")), "utf8"))
        );
        const conflicts = texturePayloads.flatMap(({ target, bytes }) => {
          const identifier = PathModule.basename(target, ".png");
          const others = owners.get(identifier);
          if (!others) return [];
          if (fs.existsSync(target) && Buffer.from(fs.readFileSync(target)).equals(bytes)) return [];
          return [`"${identifier}" (used by ${others.join(", ")})`];
        });
        if (conflicts.length > 0) {
          throw new Error(
            `Texture identifier conflict in ${outputRoot}: ${conflicts.join("; ")}. ` +
            "Writing a different image would change those models. Rename this model's texture in Blockbench, or export with copy_textures: false."
          );
        }
      }

      const writtenFiles: string[] = [];
      for (const [relativePath, content] of Object.entries(compiled.files)) {
        const target = PathModule.join(outputRoot, ...relativePath.split("/"));
        fs.mkdirSync(PathModule.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, "utf8");
        writtenFiles.push(target);
      }

      const textureFiles: string[] = [];
      for (const { target, bytes } of texturePayloads) {
          fs.mkdirSync(PathModule.dirname(target), { recursive: true });
          fs.writeFileSync(target, bytes);
          textureFiles.push(target);
      }

      return JSON.stringify(
        {
          model: args.model_name,
          armature: captured.armature,
          output_path: outputRoot,
          files: writtenFiles,
          textures: textureFiles,
          counts: {
            bones: captured.document.skeleton.bones.length,
            mesh_parts: captured.document.meshes.length,
            vertices: captured.document.meshes.reduce(
              (sum, mesh) => sum + mesh.vertices.length,
              0
            ),
            triangles: captured.document.meshes.reduce(
              (sum, mesh) => sum + mesh.indices.length,
              0
            ),
            animations: captured.document.animations.length,
          },
          warnings: issues.filter((issue) => issue.severity === "warning"),
          compatibility_note:
            "Structural validation passed. Import the resource pack in the current Minecraft China developer editor for the final compatibility check.",
        },
        null,
        2
      );
    },
  }, neteaseToolDocs[3].status);
}
