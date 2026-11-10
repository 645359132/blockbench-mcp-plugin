import { expect, test } from "bun:test";
import {
  compileNeteaseResourcePack,
  findTextureOwners,
  validateNeteaseInterchange,
  type NeteaseInterchange,
} from "../lib/netease/exporter";

function interchange(): NeteaseInterchange {
  return {
    format_version: 1,
    model: {
      name: "winged_orb",
      dy_load: true,
      material: "entity_for_skeleton",
      texture: { tex0: "winged_orb" },
    },
    skeleton: {
      bones: [{
        name: "root",
        parent: "root",
        initpos: [0, 0, 0],
        initquaternion: [0, 0, 0, 1],
        initscale: [1, 1, 1],
        offmtx: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]],
        boundingbox: [[0, 0, 0], [1, 1, 0]],
      }],
      boundingbox: [[0, 0, 0], [1, 1, 0]],
    },
    meshes: [{
      material: "winged_orb",
      indices: [[0, 1, 2]],
      vertices: [
        { pos: [0, 0, 0], normal: [0, 0, 1], uvcoord: [0, 0], weight: [["root", 1]] },
        { pos: [1, 0, 0], normal: [0, 0, 1], uvcoord: [1, 0], weight: [["root", 1]] },
        { pos: [0, 1, 0], normal: [0, 0, 1], uvcoord: [0, 1], weight: [["root", 1]] },
      ],
    }],
    animations: [{
      short_name: "idle",
      data: {
        tracks: [{
          keyFramesSize: 1,
          keyframes: [{ quaternion: [0, 0, 0, 1], scale: [1, 1, 1], pos: [0, 0, 0], time: 0 }],
          bone: "root",
          chanelMask: 2,
        }],
        length: 1,
        trackSize: 1,
        name: "winged_orb.idle",
        ID: "winged_orb.idle",
      },
    }],
  };
}

test("validates and compiles the observed NetEase resource-pack layout", () => {
  const document = interchange();
  expect(validateNeteaseInterchange(document)).toEqual([]);
  const result = compileNeteaseResourcePack(document, {
    existing: { custom: true },
  });

  expect(Object.keys(result.files).sort()).toEqual([
    "models/animation/winged_orb_animation_idle.json",
    "models/bind/winged_orb_bind.json",
    "models/mesh/winged_orb_mesh.json",
    "models/netease_models.json",
    "models/skeleton/winged_orb_skeleton.json",
    "nmb-interchange.json",
  ]);
  expect(result.registry.existing).toEqual({ custom: true });
  expect(result.registry.winged_orb).toEqual({
    skeleton: "skeleton/winged_orb_skeleton.json",
    mesh: "mesh/winged_orb_mesh.json",
    animation: { idle: "animation/winged_orb_animation_idle.json" },
    dy_load: true,
    material: "entity_for_skeleton",
    texture: { tex0: "winged_orb" },
  });
});

test("accepts observed runtime-overridden empty mesh materials with a warning", () => {
  const document = interchange();
  document.meshes[0].material = "";
  document.model.material = [];
  document.model.material_cpu = [];
  const issues = validateNeteaseInterchange(document);
  expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
  expect(issues.map((issue) => issue.code)).toContain("NMB029");
  const registry = compileNeteaseResourcePack(document).registry.winged_orb as Record<string, unknown>;
  expect(registry.material).toEqual([]);
  expect(registry.material_cpu).toEqual([]);
});

test("accepts MC Studio single-bone weight rounding", () => {
  const document = interchange();
  document.meshes[0].vertices[0].weight = [["root", 0.999999]];
  expect(
    validateNeteaseInterchange(document).filter((issue) => issue.severity === "error")
  ).toEqual([]);
});

test("rejects blended weights and broken animation counts", () => {
  const document = interchange();
  document.meshes[0].vertices[0].weight = [["missing", 0.5]];
  document.animations[0].data.trackSize = 2;
  const codes = validateNeteaseInterchange(document).map((issue) => issue.code);
  expect(codes).toContain("NMB027");
  expect(codes).toContain("NMB033");
});

test("rejects animation short-name collisions before files can be overwritten", () => {
  const document = interchange();
  const duplicate = structuredClone(document.animations[0]);
  duplicate.data.length = 2;
  document.animations.push(duplicate);

  expect(validateNeteaseInterchange(document)).toContainEqual({
    severity: "error",
    code: "NMB031",
    message: "Duplicate animation short name: idle.",
    location: "animations[1].short_name",
  });
  expect(() => compileNeteaseResourcePack(document)).toThrow("Duplicate animation short name: idle.");
});

test("texture owners come from other registry models' meshes and overrides", () => {
  const meshes: Record<string, unknown> = {
    "mesh/orb_mesh.json": { mesh: [{ material: "shared" }, { material: "orb_eye" }] },
    "mesh/broken_mesh.json": "not json",
  };
  const owners = findTextureOwners({
    orb: { mesh: "mesh/orb_mesh.json", texture: { tex0: "orb_glow" } },
    broken: { mesh: "mesh/broken_mesh.json" },
    missing: { mesh: "mesh/missing_mesh.json" },
    winged_orb: { mesh: "mesh/winged_orb_mesh.json", texture: { tex0: "mine" } },
  }, "winged_orb", (path) => {
    if (!(path in meshes)) throw new Error("ENOENT");
    return meshes[path];
  });
  expect(Object.fromEntries(owners)).toEqual({
    orb_glow: ["orb"], shared: ["orb"], orb_eye: ["orb"],
  });
});
