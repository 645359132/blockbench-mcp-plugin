import { expect, test } from "bun:test";
import {
  validateNeteaseProject,
  type NeteaseProjectSnapshot,
} from "../lib/netease/validator";

function validSnapshot(): NeteaseProjectSnapshot {
  return {
    formatId: "free",
    formatSupportsMeshes: true,
    formatSupportsArmatures: true,
    projectTextureCount: 1,
    armatures: [
      {
        id: "armature-1",
        name: "character",
        boneNames: ["root", "body"],
      },
    ],
    meshes: [
      {
        id: "mesh-1",
        name: "body_mesh",
        armatureId: "armature-1",
        textureIds: ["texture-1"],
        faceVertexCounts: [3],
        vertices: [
          {
            key: "v0",
            weights: [{ boneId: "bone-1", boneName: "root", weight: 1 }],
          },
          {
            key: "v1",
            weights: [{ boneId: "bone-1", boneName: "root", weight: 1 }],
          },
          {
            key: "v2",
            weights: [{ boneId: "bone-2", boneName: "body", weight: 1 }],
          },
        ],
      },
    ],
  };
}

test("accepts a conservative rigid-skinned source model", () => {
  const result = validateNeteaseProject(validSnapshot());
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.summary).toEqual({
    meshes: 1,
    armatures: 1,
    bones: 2,
    vertices: 3,
    faces: 1,
    projectTextures: 1,
    usedTextures: 1,
  });
});

test("reports detached, unweighted and multiply-weighted vertices", () => {
  const snapshot = validSnapshot();
  snapshot.meshes[0]!.armatureId = null;
  snapshot.meshes[0]!.vertices[0]!.weights = [];
  snapshot.meshes[0]!.vertices[1]!.weights = [
    { boneId: "bone-1", boneName: "root", weight: 0.5 },
    { boneId: "bone-2", boneName: "body", weight: 0.5 },
  ];

  const result = validateNeteaseProject(snapshot);
  expect(result.valid).toBe(false);
  expect(result.errors.map((issue) => issue.code)).toEqual(
    expect.arrayContaining([
      "mesh_without_armature",
      "unweighted_vertex",
      "multiple_bone_influences",
    ])
  );
});

test("separates compatibility warnings from hard errors", () => {
  const snapshot = validSnapshot();
  snapshot.projectTextureCount = 2;
  snapshot.meshes[0]!.textureIds.push("texture-2");
  snapshot.armatures[0]!.boneNames[1] = "身体";

  const result = validateNeteaseProject(snapshot);
  expect(result.valid).toBe(true);
  expect(result.warnings.map((issue) => issue.code)).toEqual(
    expect.arrayContaining(["texture_limit", "unsafe_bone_name"])
  );
});

test("treats large observed effect meshes as a profile warning by default", () => {
  const snapshot = validSnapshot();
  const template = snapshot.meshes[0]!.vertices[0]!;
  snapshot.meshes[0]!.vertices = Array.from({ length: 1200 }, (_, index) => ({
    key: `v${index}`,
    weights: template.weights,
  }));
  const result = validateNeteaseProject(snapshot);
  expect(result.valid).toBe(true);
  expect(result.warnings.map((issue) => issue.code)).toContain("vertex_hard_limit");
});
