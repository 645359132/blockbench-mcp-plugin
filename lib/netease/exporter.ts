export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];
export type Matrix3x4 = [Vec4, Vec4, Vec4];
export type BoundingBox = [Vec3, Vec3];

export interface NeteaseBone {
  name: string;
  parent: string;
  initpos: Vec3;
  initquaternion: Vec4;
  initscale: Vec3;
  offmtx: Matrix3x4;
  boundingbox: BoundingBox;
}

export interface NeteaseVertex {
  pos: Vec3;
  normal: Vec3;
  uvcoord: Vec2;
  weight: [[string, number]];
}

export interface NeteaseMeshPart {
  material: string;
  indices: [number, number, number][];
  vertices: NeteaseVertex[];
}

export interface NeteaseAnimationKeyframe {
  quaternion: Vec4;
  scale: Vec3;
  pos: Vec3;
  time: number;
}

export interface NeteaseAnimationTrack {
  keyFramesSize: number;
  keyframes: NeteaseAnimationKeyframe[];
  bone: string;
  chanelMask: number;
}

export interface NeteaseAnimationData {
  tracks: NeteaseAnimationTrack[];
  length: number;
  trackSize: number;
  name: string;
  ID: string;
}

export interface NeteaseAnimationEntry {
  short_name: string;
  data: NeteaseAnimationData;
}

export interface NeteaseModelMetadata {
  name: string;
  dy_load?: boolean;
  material?: string | string[];
  material_cpu?: string | string[];
  texture?: Partial<Record<"tex0" | "tex1" | "tex2" | "tex3", string>>;
  arm_model?: string;
  useSplitMeshes?: boolean;
  splitBonesGroup?: Record<string, unknown>;
}

export interface NeteaseInterchange {
  format_version: 1;
  model: NeteaseModelMetadata;
  skeleton: {
    bones: NeteaseBone[];
    boundingbox: BoundingBox;
  };
  meshes: NeteaseMeshPart[];
  animations: NeteaseAnimationEntry[];
}

export interface NeteaseInterchangeIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  location?: string;
}

export interface CompiledNeteasePack {
  files: Record<string, string>;
  registry: Record<string, unknown>;
}

const SAFE_NAME = /^[a-z][a-z0-9_]*$/;

function finiteVector(value: unknown, length: number): boolean {
  return Array.isArray(value) && value.length === length && value.every(
    (entry) => typeof entry === "number" && Number.isFinite(entry)
  );
}

function checkName(
  value: unknown,
  location: string,
  issues: NeteaseInterchangeIssue[],
  severity: "error" | "warning" = "error"
): void {
  if (typeof value !== "string" || !SAFE_NAME.test(value)) {
    issues.push({
      severity,
      code: "NMB001",
      message: "Name should start with a lowercase ASCII letter and contain only lowercase letters, digits, and underscores. Legacy editor output may still use other bone names.",
      location,
    });
  }
}

export function validateNeteaseInterchange(
  document: NeteaseInterchange
): NeteaseInterchangeIssue[] {
  const issues: NeteaseInterchangeIssue[] = [];
  checkName(document.model?.name, "model.name", issues);

  const bones = document.skeleton?.bones ?? [];
  if (bones.length === 0) {
    issues.push({ severity: "error", code: "NMB010", message: "At least one bone is required.", location: "skeleton.bones" });
  }
  if (bones.length > 50) {
    issues.push({ severity: "error", code: "NMB011", message: `Bone count ${bones.length} exceeds the engine limit of 50.`, location: "skeleton.bones" });
  } else if (bones.length > 20) {
    issues.push({ severity: "warning", code: "NMB012", message: `Bone count ${bones.length} exceeds the recommended limit of 20.`, location: "skeleton.bones" });
  }

  const boneNames = new Set<string>();
  bones.forEach((bone, index) => {
    const location = `skeleton.bones[${index}]`;
    checkName(bone.name, `${location}.name`, issues, "warning");
    if (boneNames.has(bone.name)) {
      issues.push({ severity: "error", code: "NMB014", message: `Duplicate bone name: ${bone.name}.`, location });
    }
    boneNames.add(bone.name);
    for (const [field, length] of [
      ["initpos", 3],
      ["initquaternion", 4],
      ["initscale", 3],
    ] as const) {
      if (!finiteVector(bone[field], length)) {
        issues.push({ severity: "error", code: "NMB015", message: `${field} must contain ${length} finite numbers.`, location });
      }
    }
  });
  bones.forEach((bone, index) => {
    if (bone.parent !== bone.name && !boneNames.has(bone.parent)) {
      issues.push({ severity: "error", code: "NMB016", message: `Parent bone does not exist: ${bone.parent}.`, location: `skeleton.bones[${index}].parent` });
    }
  });

  if (!document.meshes?.length) {
    issues.push({ severity: "error", code: "NMB020", message: "At least one mesh part is required.", location: "meshes" });
  }
  document.meshes.forEach((mesh, meshIndex) => {
    const location = `meshes[${meshIndex}]`;
    if (mesh.material === "") {
      issues.push({
        severity: "warning",
        code: "NMB029",
        message: "Mesh material is empty; the model must receive a texture or material from registry/runtime configuration.",
        location: `${location}.material`,
      });
    } else {
      checkName(mesh.material, `${location}.material`, issues);
    }
    if (!mesh.vertices.length) {
      issues.push({ severity: "error", code: "NMB022", message: "Mesh part has no vertices.", location: `${location}.vertices` });
    }
    if (!mesh.indices.length) {
      issues.push({ severity: "error", code: "NMB023", message: "Mesh part has no triangles.", location: `${location}.indices` });
    }
    mesh.vertices.forEach((vertex, vertexIndex) => {
      const vertexLocation = `${location}.vertices[${vertexIndex}]`;
      for (const [field, length] of [
        ["pos", 3],
        ["normal", 3],
        ["uvcoord", 2],
      ] as const) {
        if (!finiteVector(vertex[field], length)) {
          issues.push({ severity: "error", code: "NMB025", message: `${field} must contain ${length} finite numbers.`, location: vertexLocation });
        }
      }
      if (!Array.isArray(vertex.weight) || vertex.weight.length !== 1) {
        issues.push({ severity: "error", code: "NMB026", message: "Each vertex must bind to exactly one bone.", location: vertexLocation });
      } else if (
        !boneNames.has(vertex.weight[0][0]) ||
        typeof vertex.weight[0][1] !== "number" ||
        Math.abs(vertex.weight[0][1] - 1) > 0.0001
      ) {
        issues.push({ severity: "error", code: "NMB027", message: "Vertex weight must reference an existing bone with weight 1.", location: vertexLocation });
      }
    });
    mesh.indices.forEach((triangle, triangleIndex) => {
      if (
        !Array.isArray(triangle) ||
        triangle.length !== 3 ||
        triangle.some((index) => !Number.isInteger(index) || index < 0 || index >= mesh.vertices.length)
      ) {
        issues.push({ severity: "error", code: "NMB028", message: "Triangle must contain three valid vertex indices.", location: `${location}.indices[${triangleIndex}]` });
      }
    });
  });

  const animationNames = new Set<string>();
  document.animations.forEach((animation, animationIndex) => {
    const location = `animations[${animationIndex}]`;
    checkName(animation.short_name, `${location}.short_name`, issues);
    if (animationNames.has(animation.short_name)) {
      issues.push({ severity: "error", code: "NMB031", message: `Duplicate animation short name: ${animation.short_name}.`, location: `${location}.short_name` });
    }
    animationNames.add(animation.short_name);
    if (animation.data.trackSize !== animation.data.tracks.length) {
      issues.push({ severity: "error", code: "NMB033", message: "trackSize does not match the number of tracks.", location: `${location}.data` });
    }
    animation.data.tracks.forEach((track, trackIndex) => {
      const trackLocation = `${location}.data.tracks[${trackIndex}]`;
      if (!boneNames.has(track.bone)) {
        issues.push({ severity: "error", code: "NMB034", message: `Animation references missing bone: ${track.bone}.`, location: trackLocation });
      }
      if (!track.keyframes.length) {
        issues.push({ severity: "error", code: "NMB035", message: "Animation track requires at least one keyframe.", location: trackLocation });
      }
      if (track.keyFramesSize !== track.keyframes.length) {
        issues.push({ severity: "error", code: "NMB036", message: "keyFramesSize does not match the keyframe count.", location: trackLocation });
      }
    });
  });
  return issues;
}

export function compileNeteaseResourcePack(
  document: NeteaseInterchange,
  existingRegistry: Record<string, unknown> = {},
  compact = false
): CompiledNeteasePack {
  const name = document.model.name;
  const stringify = (value: unknown): string => JSON.stringify(value, null, compact ? 0 : 2) + "\n";
  const files: Record<string, string> = {};

  files[`models/skeleton/${name}_skeleton.json`] = stringify({
    skeleton: document.skeleton.bones,
    boundingbox: document.skeleton.boundingbox,
  });
  files[`models/mesh/${name}_mesh.json`] = stringify({ mesh: document.meshes });
  files[`models/bind/${name}_bind.json`] = stringify({
    model: {
      [name]: {
        bind: { default: {} },
        sounds: { default: [] },
        animation: { "": "default" },
        animation_speed: {},
      },
    },
    version: "1.2.0",
    description: {
      file_type: "bind",
      model_type: "model",
      model: name,
    },
    editor: { show: { default: true } },
  });

  const animationPaths: Record<string, string> = {};
  for (const animation of document.animations) {
    if (Object.hasOwn(animationPaths, animation.short_name)) {
      throw new Error(`Duplicate animation short name: ${animation.short_name}.`);
    }
    const relative = `animation/${name}_animation_${animation.short_name}.json`;
    files[`models/${relative}`] = stringify({ animation: animation.data });
    animationPaths[animation.short_name] = relative;
  }

  const entry: Record<string, unknown> = {
    skeleton: `skeleton/${name}_skeleton.json`,
    mesh: `mesh/${name}_mesh.json`,
    animation: animationPaths,
    dy_load: document.model.dy_load ?? true,
  };
  for (const key of [
    "material",
    "material_cpu",
    "texture",
    "arm_model",
    "useSplitMeshes",
    "splitBonesGroup",
  ] as const) {
    if (document.model[key] !== undefined) entry[key] = document.model[key];
  }

  const registry = { ...existingRegistry, [name]: entry };
  files["models/netease_models.json"] = stringify(registry);
  files["nmb-interchange.json"] = stringify(document);
  return { files, registry };
}

/**
 * Maps each texture identifier referenced by other registry models to their names.
 * Texture files are shared by identifier, so exporting a different image under an
 * identifier another model uses would silently change that model.
 */
export function findTextureOwners(
  registry: Record<string, unknown>,
  modelName: string,
  readMeshFile: (relativePath: string) => unknown
): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  const add = (identifier: unknown, owner: string): void => {
    if (typeof identifier !== "string" || !identifier) return;
    const names = owners.get(identifier) ?? [];
    if (!names.includes(owner)) names.push(owner);
    owners.set(identifier, names);
  };
  for (const [name, entry] of Object.entries(registry)) {
    if (name === modelName || !entry || typeof entry !== "object") continue;
    const { texture, mesh } = entry as { texture?: unknown; mesh?: unknown };
    if (texture && typeof texture === "object") {
      for (const identifier of Object.values(texture)) add(identifier, name);
    }
    if (typeof mesh !== "string") continue;
    let parsed: unknown;
    try {
      parsed = readMeshFile(mesh);
    } catch {
      continue;
    }
    const parts = (parsed as { mesh?: unknown } | undefined)?.mesh;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const material = (part as { material?: unknown } | undefined)?.material;
      for (const identifier of Array.isArray(material) ? material : [material]) add(identifier, name);
    }
  }
  return owners;
}
