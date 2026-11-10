/// <reference types="three" />
/// <reference types="blockbench-types" />
import type {
  BoundingBox,
  Matrix3x4,
  NeteaseAnimationEntry,
  NeteaseAnimationKeyframe,
  NeteaseBone,
  NeteaseInterchange,
  NeteaseMeshPart,
  NeteaseModelMetadata,
  NeteaseVertex,
  Vec2,
  Vec3,
  Vec4,
} from "@/lib/netease/exporter";

export interface CaptureNeteaseOptions {
  model: NeteaseModelMetadata;
  armatureId?: string;
  centimetersPerUnit: number;
  animationIds?: string[];
  includeAnimations: boolean;
}

export interface CapturedNeteaseProject {
  document: NeteaseInterchange;
  textures: Map<string, Texture>;
  armature: { uuid: string; name: string };
}

const SAFE_NAME = /^[a-z][a-z0-9_]*$/;

function round(value: number): number {
  const result = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(result, -0) ? 0 : result;
}

function vec2(x: number, y: number): Vec2 {
  return [round(x), round(y)];
}

function vec3(x: number, y: number, z: number): Vec3 {
  return [round(x), round(y), round(z)];
}

function vec4(x: number, y: number, z: number, w: number): Vec4 {
  return [round(x), round(y), round(z), round(w)];
}

function textureIdentifier(texture: Texture): string {
  const sourceName = texture.name.replace(/\.[^.]+$/, "").toLowerCase();
  if (!SAFE_NAME.test(sourceName)) {
    throw new Error(
      `Texture "${texture.name}" must resolve to a lowercase ASCII identifier before NetEase export.`
    );
  }
  return sourceName;
}

function boundingBox(points: Vec3[]): BoundingBox {
  if (points.length === 0) return [[0, 0, 0], [0, 0, 0]];
  const min: Vec3 = [...points[0]] as Vec3;
  const max: Vec3 = [...points[0]] as Vec3;
  for (const point of points.slice(1)) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  }
  return [min.map(round) as Vec3, max.map(round) as Vec3];
}

function matrix3x4(matrix: any, scale: number): Matrix3x4 {
  const e = matrix.elements as number[];
  return [
    vec4(e[0], e[4], e[8], e[12] * scale),
    vec4(e[1], e[5], e[9], e[13] * scale),
    vec4(e[2], e[6], e[10], e[14] * scale),
  ];
}

function transformPointByMatrix3x4(point: Vec3, matrix: Matrix3x4): Vec3 {
  return vec3(
    matrix[0][0] * point[0] + matrix[0][1] * point[1] + matrix[0][2] * point[2] + matrix[0][3],
    matrix[1][0] * point[0] + matrix[1][1] * point[1] + matrix[1][2] * point[2] + matrix[1][3],
    matrix[2][0] * point[0] + matrix[2][1] * point[1] + matrix[2][2] * point[2] + matrix[2][3]
  );
}

function resolveArmature(id?: string): Armature {
  const armatures = Armature.all.filter((armature) => armature.export !== false);
  if (id) {
    const armature = armatures.find(
      (candidate) =>
        candidate.uuid === id || candidate.name === id || candidate.uuid.startsWith(id)
    );
    if (!armature) throw new Error(`Armature not found: ${id}`);
    return armature;
  }
  if (armatures.length !== 1) {
    throw new Error(
      `Expected exactly one exported armature, found ${armatures.length}. Provide armature_id explicitly.`
    );
  }
  return armatures[0];
}

function collectMeshParts(
  armature: Armature,
  scale: number,
  bones: ArmatureBone[]
): {
  meshes: NeteaseMeshPart[];
  textures: Map<string, Texture>;
  allPoints: Vec3[];
  bonePoints: Map<string, Vec3[]>;
} {
  const THREE_API = (globalThis as any).THREE;
  const armatureInverse = new THREE_API.Matrix4()
    .copy((armature as any).scene_object.matrixWorld)
    .invert();
  const parts = new Map<
    string,
    NeteaseMeshPart & { lookup: Map<string, number> }
  >();
  const textures = new Map<string, Texture>();
  const allPoints: Vec3[] = [];
  const bonePoints = new Map<string, Vec3[]>();

  const meshes = armature.children.filter(
    (child): child is Mesh => child instanceof Mesh && child.export !== false
  );
  if (meshes.length === 0) {
    throw new Error(`Armature "${armature.name}" has no directly attached exported meshes.`);
  }

  for (const mesh of meshes) {
    (mesh as any).scene_object.updateMatrixWorld(true);
    const relativeMatrix = new THREE_API.Matrix4()
      .copy(armatureInverse)
      .multiply((mesh as any).scene_object.matrixWorld);
    const normalMatrix = new THREE_API.Matrix3().getNormalMatrix(relativeMatrix);
    const calculatedNormals = mesh.calculateNormals();

    for (const face of Object.values(mesh.faces)) {
      const ordered = face.getSortedVertices();
      if (ordered.length < 3) continue;
      const texture = face.getTexture();
      if (!texture) {
        throw new Error(`Mesh "${mesh.name}" contains an untextured face.`);
      }
      const material = textureIdentifier(texture);
      const existingTexture = textures.get(material);
      if (existingTexture && existingTexture.uuid !== texture.uuid) {
        throw new Error(
          `Textures "${existingTexture.name}" and "${texture.name}" resolve to the same NetEase identifier "${material}". Give each texture a distinct lowercase name before exporting.`
        );
      }
      textures.set(material, texture);
      const part = parts.get(material) ?? {
        material,
        indices: [],
        vertices: [],
        lookup: new Map<string, number>(),
      };
      parts.set(material, part);

      const triangles: string[][] = [];
      for (let index = 1; index < ordered.length - 1; index++) {
        triangles.push([ordered[0], ordered[index], ordered[index + 1]]);
      }

      for (const triangle of triangles) {
        const outputTriangle: [number, number, number] = [0, 0, 0];
        triangle.forEach((vertexKey, cornerIndex) => {
          const influences = bones.flatMap((bone) => {
            const weight = bone.getVertexWeight(mesh, vertexKey);
            return weight > 0 ? [{ bone, weight }] : [];
          });
          if (influences.length !== 1 || Math.abs(influences[0].weight - 1) > 0.0001) {
            throw new Error(
              `Vertex "${vertexKey}" in mesh "${mesh.name}" must have exactly one bone influence with weight 1.`
            );
          }
          const boneName = influences[0].bone.name;

          const positionVector = new THREE_API.Vector3()
            .fromArray(mesh.vertices[vertexKey])
            .applyMatrix4(relativeMatrix);
          const pos = vec3(
            positionVector.x * scale,
            positionVector.y * scale,
            positionVector.z * scale
          );
          const rawNormal = calculatedNormals[vertexKey] ?? face.getNormal(true);
          const normalVector = new THREE_API.Vector3()
            .fromArray(rawNormal)
            .applyMatrix3(normalMatrix)
            .normalize();
          const normal = vec3(normalVector.x, normalVector.y, normalVector.z);
          const rawUv = face.uv[vertexKey] ?? [0, 0];
          const textureWithUv = texture as Texture & {
            uv_width?: number;
            uv_height?: number;
            width?: number;
            height?: number;
          };
          const width = textureWithUv.uv_width ?? textureWithUv.width ?? Project!.texture_width;
          const height = textureWithUv.uv_height ?? textureWithUv.height ?? Project!.texture_height;
          const uvcoord = vec2(rawUv[0] / width, rawUv[1] / height);
          const key = JSON.stringify([pos, normal, uvcoord, boneName]);
          let outputIndex = part.lookup.get(key);
          if (outputIndex === undefined) {
            outputIndex = part.vertices.length;
            const vertex: NeteaseVertex = {
              pos,
              normal,
              uvcoord,
              weight: [[boneName, 1]],
            };
            part.vertices.push(vertex);
            part.lookup.set(key, outputIndex);
            allPoints.push(pos);
            const assignedPoints = bonePoints.get(boneName) ?? [];
            assignedPoints.push(pos);
            bonePoints.set(boneName, assignedPoints);
          }
          outputTriangle[cornerIndex] = outputIndex;
        });
        part.indices.push(outputTriangle);
      }
    }
  }

  return {
    meshes: [...parts.values()].map(({ lookup: _lookup, ...part }) => part),
    textures,
    allPoints,
    bonePoints,
  };
}

function collectSkeleton(
  armature: Armature,
  bones: ArmatureBone[],
  scale: number,
  allPoints: Vec3[],
  bonePoints: Map<string, Vec3[]>
): NeteaseInterchange["skeleton"] {
  const result: NeteaseBone[] = bones.map((bone) => {
    const scene = (bone as any).scene_object;
    const parent = bone.parent instanceof ArmatureBone ? bone.parent.name : bone.name;
    const offmtx = matrix3x4(scene.inverse_bind_matrix, scale);
    const localPoints = (bonePoints.get(bone.name) ?? []).map((point) =>
      transformPointByMatrix3x4(point, offmtx)
    );
    return {
      name: bone.name,
      parent,
      initpos: vec3(
        scene.position.x * scale,
        scene.position.y * scale,
        scene.position.z * scale
      ),
      initquaternion: vec4(
        scene.quaternion.x,
        scene.quaternion.y,
        scene.quaternion.z,
        scene.quaternion.w
      ),
      initscale: vec3(scene.scale.x, scene.scale.y, scene.scale.z),
      offmtx,
      boundingbox: boundingBox(localPoints),
    };
  });
  return { bones: result, boundingbox: boundingBox(allPoints) };
}

function animationShortName(animation: any): string {
  const raw = String(animation.getShortName?.() ?? animation.name.split(".").at(-1) ?? "");
  if (!SAFE_NAME.test(raw)) {
    throw new Error(`Animation "${animation.name}" must have a lowercase ASCII short name.`);
  }
  return raw;
}

function collectAnimations(
  armature: Armature,
  bones: ArmatureBone[],
  modelName: string,
  scale: number,
  animationIds?: string[]
): NeteaseAnimationEntry[] {
  const animations = ((globalThis as any).Animation?.all ?? []) as any[];
  const selected = animationIds
    ? animations.filter((animation) =>
        animationIds.some(
          (id) =>
            animation.uuid === id ||
            animation.name === id ||
            animationShortName(animation) === id
        )
      )
    : animations;
  if (animationIds && selected.length !== new Set(animationIds).size) {
    throw new Error("One or more requested animation_ids were not found.");
  }

  const oldTime = (globalThis as any).Timeline.time;
  const oldSelected = (globalThis as any).Animation?.selected;
  const result: NeteaseAnimationEntry[] = [];

  try {
    for (const animation of selected) {
      const shortName = animationShortName(animation);
      const animators = Object.values(animation.animators ?? {}).filter((animator: any) => {
        const element = animator.getElement?.() ?? animator.getGroup?.();
        return element instanceof ArmatureBone && element.getArmature?.() === armature;
      }) as any[];
      if (animators.length === 0) continue;

      const tracks = animators.map((animator) => {
        const bone = animator.getElement?.() ?? animator.getGroup?.();
        const times = new Set<number>([0, Number(animation.length) || 0]);
        for (const keyframe of animator.keyframes ?? []) times.add(Number(keyframe.time));
        const sortedTimes = [...times].filter(Number.isFinite).sort((a, b) => a - b);
        const keyframes: NeteaseAnimationKeyframe[] = [];

        const channels: Record<string, any[]> = {
          position: [...((animator as any).position ?? [])].sort((a, b) => a.time - b.time),
          rotation: [...((animator as any).rotation ?? [])].sort((a, b) => a.time - b.time),
          scale: [...((animator as any).scale ?? [])].sort((a, b) => a.time - b.time),
        };
        for (const [channel, channelKeyframes] of Object.entries(channels)) {
          for (const keyframe of channelKeyframes) {
            const location = `Animation "${animation.name}", bone "${bone.name}", ${channel} at ${keyframe.time}`;
            if (keyframe.interpolation && keyframe.interpolation !== "linear") {
              throw new Error(`${location}: NetEase export currently supports only linear interpolation. Bake the animation to linear keyframes before exporting.`);
            }
            if ((keyframe.data_points?.length ?? 0) > 1) {
              throw new Error(`${location}: NetEase export currently supports one data point per keyframe. Bake the animation to linear keyframes before exporting.`);
            }
            const point = keyframe.data_points?.[0] ?? {};
            for (const axis of ["x", "y", "z"]) {
              const value = point[axis];
              if (value === undefined) continue;
              if (
                (typeof value !== "number" && typeof value !== "string") ||
                (typeof value === "string" && value.trim() === "") ||
                !Number.isFinite(Number(value))
              ) {
                throw new Error(`${location}: ${axis} must be a finite numeric value. Bake Molang expressions to numeric keyframes before exporting.`);
              }
            }
          }
        }
        const keyframeValues = (keyframe: any): number[] => {
          const point = (keyframe?.data_points ?? [])[0] ?? {};
          return [Number(point.x) || 0, Number(point.y) || 0, Number(point.z) || 0];
        };
        for (let index = 1; index < channels.rotation.length; index++) {
          const previous = keyframeValues(channels.rotation[index - 1]);
          const current = keyframeValues(channels.rotation[index]);
          if (current.some((value, axis) => Math.abs(value - previous[axis]) > 180)) {
            throw new Error(
              `Animation "${animation.name}", bone "${bone.name}": adjacent rotation keyframes must differ by at most 180 degrees on each axis. Subdivide the rotation into linear keyframes with steps of 180 degrees or less before exporting.`
            );
          }
        }
        const sampleChannel = (list: any[], time: number): number[] | null => {
          if (list.length === 0) return null;
          if (time <= list[0].time) return keyframeValues(list[0]);
          const last = list[list.length - 1];
          if (time >= last.time) return keyframeValues(last);
          let previous = list[0];
          let next = last;
          for (const keyframe of list) {
            if (keyframe.time <= time) previous = keyframe;
            if (keyframe.time >= time) {
              next = keyframe;
              break;
            }
          }
          const span = next.time - previous.time || 1;
          const mix = (time - previous.time) / span;
          const from = keyframeValues(previous);
          const to = keyframeValues(next);
          return [0, 1, 2].map((axis) => from[axis] + (to[axis] - from[axis]) * mix);
        };
        const eulerOrder = (globalThis as any).Format?.euler_order ?? "ZYX";
        const SamplerTHREE = (globalThis as any).THREE;
        for (const time of sortedTimes) {
          const restRotation = (bone as any).rotation ?? [0, 0, 0];
          const restOrigin = (bone as any).origin ?? [0, 0, 0];
          const animatedRotation = sampleChannel(channels.rotation, time) ?? [0, 0, 0];
          const animatedPosition = sampleChannel(channels.position, time) ?? [0, 0, 0];
          const animatedScale = sampleChannel(channels.scale, time) ?? [1, 1, 1];
          const euler = new SamplerTHREE.Euler(
            SamplerTHREE.MathUtils.degToRad(restRotation[0] + animatedRotation[0]),
            SamplerTHREE.MathUtils.degToRad(restRotation[1] + animatedRotation[1]),
            SamplerTHREE.MathUtils.degToRad(restRotation[2] + animatedRotation[2]),
            eulerOrder
          );
          const quaternion = new SamplerTHREE.Quaternion().setFromEuler(euler);
          keyframes.push({
            quaternion: vec4(quaternion.x, quaternion.y, quaternion.z, quaternion.w),
            scale: vec3(animatedScale[0], animatedScale[1], animatedScale[2]),
            pos: vec3(
              (restOrigin[0] + animatedPosition[0]) * scale,
              (restOrigin[1] + animatedPosition[1]) * scale,
              (restOrigin[2] + animatedPosition[2]) * scale
            ),
            time: round(time),
          });
        }

        const channelMask =
          ((animator.position?.length ?? 0) > 0 ? 1 : 0) |
          ((animator.rotation?.length ?? 0) > 0 ? 2 : 0) |
          ((animator.scale?.length ?? 0) > 0 ? 4 : 0);
        return {
          keyFramesSize: keyframes.length,
          keyframes,
          bone: bone.name,
          chanelMask: channelMask,
        };
      });
      const qualifiedName = `${modelName}.${shortName}`;
      result.push({
        short_name: shortName,
        data: {
          tracks,
          length: round(Number(animation.length) || 0),
          trackSize: tracks.length,
          name: qualifiedName,
          ID: qualifiedName,
        },
      });
    }
  } finally {
    (globalThis as any).Animator.showDefaultPose(true);
    (globalThis as any).Timeline.time = oldTime;
    oldSelected?.select?.();
    (globalThis as any).Animator.preview();
  }
  return result;
}

export function captureNeteaseProject(
  options: CaptureNeteaseOptions
): CapturedNeteaseProject {
  if (!Number.isFinite(options.centimetersPerUnit) || options.centimetersPerUnit <= 0) {
    throw new Error("centimeters_per_unit must be a positive finite number.");
  }
  const armature = resolveArmature(options.armatureId);
  const bones = armature.getAllBones().filter((bone) => bone.export !== false);
  if (bones.length === 0) throw new Error(`Armature "${armature.name}" has no exported bones.`);

  const oldTime = (globalThis as any).Timeline.time;
  const oldSelected = (globalThis as any).Animation?.selected;
  try {
    (globalThis as any).Animator.showDefaultPose(true);
    for (const bone of bones) {
      bone.preview_controller.updateTransform(bone);
    }
    (armature as any).scene_object.updateMatrixWorld(true);

    const meshData = collectMeshParts(
      armature,
      options.centimetersPerUnit,
      bones
    );
    const skeleton = collectSkeleton(
      armature,
      bones,
      options.centimetersPerUnit,
      meshData.allPoints,
      meshData.bonePoints
    );
    const animations = options.includeAnimations
      ? collectAnimations(
          armature,
          bones,
          options.model.name,
          options.centimetersPerUnit,
          options.animationIds
        )
      : [];

    return {
      document: {
        format_version: 1,
        model: options.model,
        skeleton,
        meshes: meshData.meshes,
        animations,
      },
      textures: meshData.textures,
      armature: { uuid: armature.uuid, name: armature.name },
    };
  } finally {
    (globalThis as any).Animator.showDefaultPose(true);
    (globalThis as any).Timeline.time = oldTime;
    oldSelected?.select?.();
    (globalThis as any).Animator.preview();
  }
}
