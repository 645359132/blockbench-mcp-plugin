export interface NeteaseWeightSnapshot {
  boneId: string;
  boneName: string;
  weight: number;
}

export interface NeteaseVertexSnapshot {
  key: string;
  weights: NeteaseWeightSnapshot[];
}

export interface NeteaseMeshSnapshot {
  id: string;
  name: string;
  armatureId: string | null;
  vertices: NeteaseVertexSnapshot[];
  faceVertexCounts: number[];
  textureIds: string[];
}

export interface NeteaseArmatureSnapshot {
  id: string;
  name: string;
  boneNames: string[];
}

export interface NeteaseProjectSnapshot {
  formatId: string | null;
  formatSupportsMeshes: boolean;
  formatSupportsArmatures: boolean;
  projectTextureCount: number;
  meshes: NeteaseMeshSnapshot[];
  armatures: NeteaseArmatureSnapshot[];
}

export interface NeteaseValidationOptions {
  strictRigidSkinning: boolean;
  recommendedMaxVertices: number;
  hardMaxVertices: number;
  hardVertexLimitIsError: boolean;
  recommendedMaxBones: number;
  hardMaxBones: number;
  maxTextures: number;
}

export type NeteaseIssueSeverity = "error" | "warning";

export interface NeteaseValidationIssue {
  severity: NeteaseIssueSeverity;
  code: string;
  message: string;
  meshId?: string;
  vertexKey?: string;
  armatureId?: string;
}

export interface NeteaseValidationResult {
  valid: boolean;
  errors: NeteaseValidationIssue[];
  warnings: NeteaseValidationIssue[];
  summary: {
    meshes: number;
    armatures: number;
    bones: number;
    vertices: number;
    faces: number;
    projectTextures: number;
    usedTextures: number;
  };
}

export const DEFAULT_NETEASE_VALIDATION_OPTIONS: NeteaseValidationOptions = {
  strictRigidSkinning: true,
  recommendedMaxVertices: 300,
  hardMaxVertices: 1000,
  hardVertexLimitIsError: false,
  recommendedMaxBones: 20,
  hardMaxBones: 50,
  maxTextures: 1,
};

const NETEASE_SAFE_NAME = /^[A-Za-z0-9_. -]+$/;
const WEIGHT_EPSILON = 0.0001;

export function validateNeteaseProject(
  project: NeteaseProjectSnapshot,
  options: NeteaseValidationOptions = DEFAULT_NETEASE_VALIDATION_OPTIONS
): NeteaseValidationResult {
  const issues: NeteaseValidationIssue[] = [];
  const add = (issue: NeteaseValidationIssue): void => {
    issues.push(issue);
  };

  if (!project.formatSupportsMeshes || !project.formatSupportsArmatures) {
    add({
      severity: "error",
      code: "unsupported_project_format",
      message:
        "The current Blockbench format must support both polygon meshes and armature rigs.",
    });
  }
  if (project.meshes.length === 0) {
    add({ severity: "error", code: "missing_mesh", message: "The project has no polygon mesh." });
  }
  if (project.armatures.length === 0) {
    add({ severity: "error", code: "missing_armature", message: "The project has no armature." });
  }

  const totalVertices = project.meshes.reduce((sum, mesh) => sum + mesh.vertices.length, 0);
  const totalFaces = project.meshes.reduce((sum, mesh) => sum + mesh.faceVertexCounts.length, 0);
  const totalBones = project.armatures.reduce((sum, armature) => sum + armature.boneNames.length, 0);
  const usedTextureIds = new Set(project.meshes.flatMap((mesh) => mesh.textureIds));

  if (totalVertices > options.hardMaxVertices) {
    add({
      severity: options.hardVertexLimitIsError ? "error" : "warning",
      code: "vertex_hard_limit",
      message: `Model has ${totalVertices} vertices; configured profile threshold is ${options.hardMaxVertices}. Observed NetEase effect assets can exceed this value.`,
    });
  } else if (totalVertices > options.recommendedMaxVertices) {
    add({
      severity: "warning",
      code: "vertex_recommended_limit",
      message: `Model has ${totalVertices} vertices; recommended limit is ${options.recommendedMaxVertices}.`,
    });
  }

  if (totalBones > options.hardMaxBones) {
    add({
      severity: "error",
      code: "bone_hard_limit",
      message: `Model has ${totalBones} bones; configured hard limit is ${options.hardMaxBones}.`,
    });
  } else if (totalBones > options.recommendedMaxBones) {
    add({
      severity: "warning",
      code: "bone_recommended_limit",
      message: `Model has ${totalBones} bones; recommended limit is ${options.recommendedMaxBones}.`,
    });
  }

  if (project.projectTextureCount === 0) {
    add({ severity: "error", code: "missing_texture", message: "The project has no texture." });
  } else if (usedTextureIds.size > options.maxTextures) {
    add({
      severity: "warning",
      code: "texture_limit",
      message: `Model uses ${usedTextureIds.size} textures; the selected compatibility profile allows ${options.maxTextures}.`,
    });
  }

  for (const armature of project.armatures) {
    const seenNames = new Set<string>();
    for (const boneName of armature.boneNames) {
      if (!NETEASE_SAFE_NAME.test(boneName)) {
        add({
          severity: "warning",
          code: "unsafe_bone_name",
          message: `Bone "${boneName}" contains characters outside the conservative NetEase naming set.`,
          armatureId: armature.id,
        });
      }
      if (seenNames.has(boneName)) {
        add({
          severity: "error",
          code: "duplicate_bone_name",
          message: `Armature "${armature.name}" contains duplicate bone name "${boneName}".`,
          armatureId: armature.id,
        });
      }
      seenNames.add(boneName);
    }
  }

  for (const mesh of project.meshes) {
    if (!mesh.armatureId) {
      add({
        severity: "error",
        code: "mesh_without_armature",
        message: `Mesh "${mesh.name}" is not attached to an armature.`,
        meshId: mesh.id,
      });
    }
    if (mesh.vertices.length === 0) {
      add({
        severity: "error",
        code: "empty_mesh",
        message: `Mesh "${mesh.name}" has no vertices.`,
        meshId: mesh.id,
      });
    }
    if (mesh.faceVertexCounts.length === 0) {
      add({
        severity: "error",
        code: "mesh_without_faces",
        message: `Mesh "${mesh.name}" has no faces.`,
        meshId: mesh.id,
      });
    }
    if (mesh.faceVertexCounts.length > 0 && mesh.textureIds.length === 0) {
      add({
        severity: "error",
        code: "mesh_without_texture",
        message: `Mesh "${mesh.name}" has faces without an assigned texture.`,
        meshId: mesh.id,
      });
    }
    if (mesh.faceVertexCounts.some((count) => count < 3 || count > 4)) {
      add({
        severity: "error",
        code: "unsupported_face_size",
        message: `Mesh "${mesh.name}" contains a face that is not a triangle or quad.`,
        meshId: mesh.id,
      });
    }

    for (const vertex of mesh.vertices) {
      const nonZeroWeights = vertex.weights.filter((entry) => entry.weight > WEIGHT_EPSILON);
      if (nonZeroWeights.length === 0) {
        add({
          severity: "error",
          code: "unweighted_vertex",
          message: `Vertex "${vertex.key}" in mesh "${mesh.name}" has no bone weight.`,
          meshId: mesh.id,
          vertexKey: vertex.key,
        });
        continue;
      }
      if (options.strictRigidSkinning && nonZeroWeights.length !== 1) {
        add({
          severity: "error",
          code: "multiple_bone_influences",
          message: `Vertex "${vertex.key}" in mesh "${mesh.name}" is influenced by ${nonZeroWeights.length} bones; rigid NetEase compatibility requires exactly one.`,
          meshId: mesh.id,
          vertexKey: vertex.key,
        });
      }
      const sum = nonZeroWeights.reduce((total, entry) => total + entry.weight, 0);
      if (Math.abs(sum - 1) > WEIGHT_EPSILON) {
        add({
          severity: "error",
          code: "weight_sum",
          message: `Vertex "${vertex.key}" in mesh "${mesh.name}" has total weight ${sum}; expected 1.`,
          meshId: mesh.id,
          vertexKey: vertex.key,
        });
      }
    }
  }

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: {
      meshes: project.meshes.length,
      armatures: project.armatures.length,
      bones: totalBones,
      vertices: totalVertices,
      faces: totalFaces,
      projectTextures: project.projectTextureCount,
      usedTextures: usedTextureIds.size,
    },
  };
}
