import { afterAll, beforeAll, expect, test } from "bun:test";
import * as THREE from "three";
import { captureNeteaseProject } from "../lib/netease/blockbench-export";

const originals = new Map<string, PropertyDescriptor | undefined>();
let activeBone: TestArmatureBone | undefined;
const animations: any[] = [];

class TestArmatureBone {
  static all: TestArmatureBone[] = [];
  uuid = "bone-root";
  name = "root";
  export = true;
  parent: unknown;
  scene_object = new THREE.Bone() as THREE.Bone & { inverse_bind_matrix: THREE.Matrix4 };
  preview_controller = { updateTransform() {} };

  constructor(parent: unknown) {
    this.parent = parent;
    this.scene_object.inverse_bind_matrix = new THREE.Matrix4();
    TestArmatureBone.all.push(this);
  }

  getArmature() {
    return this.parent;
  }

  getVertexWeight(_mesh: TestMesh, key: string) {
    return key in _mesh.vertices ? 1 : 0;
  }
}

class TestMesh {
  static all: TestMesh[] = [];
  uuid = "mesh-body";
  name = "body";
  export = true;
  scene_object = new THREE.Object3D();
  vertices = {
    v0: [0, 0, 0],
    v1: [1, 0, 0],
    v2: [0, 1, 0],
  };
  faces: Record<string, TestFace> = {};

  calculateNormals() {
    return { v0: [0, 0, 1], v1: [0, 0, 1], v2: [0, 0, 1] };
  }
}

const texture = {
  uuid: "texture-body",
  name: "body.png",
  width: 16,
  height: 16,
};

class TestFace {
  vertices = ["v0", "v1", "v2"];
  uv = { v0: [0, 0], v1: [16, 0], v2: [0, 16] };

  constructor(private readonly boundTexture = texture) {}

  getSortedVertices() {
    return this.vertices;
  }

  getTexture() {
    return this.boundTexture;
  }

  getNormal() {
    return [0, 0, 1];
  }
}

class TestArmature {
  static all: TestArmature[] = [];
  uuid = "armature-character";
  name = "character";
  export = true;
  scene_object = new THREE.Object3D();
  children: Array<TestArmatureBone | TestMesh> = [];

  constructor() {
    TestArmature.all.push(this);
  }

  getAllBones() {
    return this.children.filter((child): child is TestArmatureBone => child instanceof TestArmatureBone);
  }
}

function install(name: string, value: unknown): void {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, value });
}

beforeAll(() => {
  install("THREE", THREE);
  install("Armature", TestArmature);
  install("ArmatureBone", TestArmatureBone);
  install("Mesh", TestMesh);
  install("Project", { texture_width: 16, texture_height: 16 });
  install("Animator", {
    showDefaultPose() {
      if (!activeBone) return;
      activeBone.scene_object.position.set(0, 0, 0);
      activeBone.scene_object.quaternion.identity();
      activeBone.scene_object.scale.set(1, 1, 1);
    },
    resetLastValues() {},
    preview() {},
  });
  install("Timeline", { time: 0 });
  install("Animation", { all: animations, selected: null });
});

afterAll(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function createTestProject(): { armature: TestArmature; bone: TestArmatureBone; mesh: TestMesh } {
  TestArmature.all.length = 0;
  TestArmatureBone.all.length = 0;
  animations.length = 0;
  const armature = new TestArmature();
  const bone = new TestArmatureBone(armature);
  activeBone = bone;
  armature.scene_object.add(bone.scene_object);
  const mesh = new TestMesh();
  mesh.faces.f0 = new TestFace();
  armature.scene_object.add(mesh.scene_object);
  armature.children.push(bone, mesh);
  armature.scene_object.updateMatrixWorld(true);
  return { armature, bone, mesh };
}

test("captures Blockbench mesh, skeleton, UV, normals and rigid weights", () => {
  const { bone } = createTestProject();
  bone.scene_object.inverse_bind_matrix.makeScale(0.5, 0.5, 0.5);

  const captured = captureNeteaseProject({
    model: { name: "test_model", material: "entity_for_skeleton" },
    centimetersPerUnit: 2,
    includeAnimations: false,
  });

  expect(captured.document.meshes).toHaveLength(1);
  expect(captured.document.meshes[0].indices).toEqual([[0, 1, 2]]);
  expect(captured.document.meshes[0].vertices[1]).toEqual({
    pos: [2, 0, 0],
    normal: [0, 0, 1],
    uvcoord: [1, 0],
    weight: [["root", 1]],
  });
  expect(captured.document.skeleton.bones[0].parent).toBe("root");
  expect(captured.document.skeleton.bones[0].boundingbox).toEqual([[0, 0, 0], [1, 1, 0]]);
  expect(captured.document.skeleton.boundingbox).toEqual([[0, 0, 0], [2, 2, 0]]);
  expect([...captured.textures.keys()]).toEqual(["body"]);
});

test("samples armature animation tracks into NetEase keyframes", () => {
  const { bone } = createTestProject();

  const animator = {
    keyframes: [{ time: 0 }, { time: 1 }],
    position: [
      { time: 0, data_points: [{ x: 0, y: 0, z: 0 }] },
      { time: 1, data_points: [{ x: 1, y: 0, z: 0 }] },
    ],
    rotation: [],
    scale: [],
    getElement: () => bone,
  };
  animations.push({
    uuid: "animation-idle",
    name: "animation.test_model.idle",
    length: 1,
    animators: { [bone.uuid]: animator },
    getShortName: () => "idle",
  });

  const captured = captureNeteaseProject({
    model: { name: "test_model" },
    centimetersPerUnit: 2,
    includeAnimations: true,
  });
  const track = captured.document.animations[0].data.tracks[0];
  expect(track.chanelMask).toBe(1);
  expect(track.keyframes.map((keyframe) => keyframe.pos)).toEqual([
    [0, 0, 0],
    [2, 0, 0],
  ]);
});

test("rejects distinct textures that resolve to the same exported identifier", () => {
  const { armature } = createTestProject();
  const mesh = new TestMesh();
  mesh.faces.f0 = new TestFace({ ...texture, uuid: "texture-other", name: "BODY.png" });
  armature.children.push(mesh);
  armature.scene_object.add(mesh.scene_object);

  expect(() => captureNeteaseProject({
    model: { name: "test_model" },
    centimetersPerUnit: 1,
    includeAnimations: false,
  })).toThrow('resolve to the same NetEase identifier "body"');
});

function addAnimationWithPositionKeyframe(bone: TestArmatureBone, keyframe: any): void {
  const animator = {
    keyframes: [keyframe],
    position: [keyframe],
    rotation: [],
    scale: [],
    getElement: () => bone,
  };
  animations.push({
    uuid: "animation-idle",
    name: "animation.test_model.idle",
    length: 1,
    animators: { [bone.uuid]: animator },
    getShortName: () => "idle",
  });
}

for (const interpolation of ["step", "catmullrom", "bezier"]) {
  test(`rejects ${interpolation} interpolation instead of silently exporting it as linear`, () => {
    const { bone } = createTestProject();
    addAnimationWithPositionKeyframe(bone, {
      time: 0,
      interpolation,
      data_points: [{ x: 0, y: 0, z: 0 }],
    });
    expect(() => captureNeteaseProject({
      model: { name: "test_model" },
      centimetersPerUnit: 1,
      includeAnimations: true,
    })).toThrow("supports only linear interpolation");
  });
}

test("rejects pre/post keyframe values instead of discarding the second value", () => {
  const { bone } = createTestProject();
  addAnimationWithPositionKeyframe(bone, {
    time: 0,
    data_points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }],
  });
  expect(() => captureNeteaseProject({
    model: { name: "test_model" },
    centimetersPerUnit: 1,
    includeAnimations: true,
  })).toThrow("one data point per keyframe");
});

for (const value of ["query.anim_time * 2", Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`rejects nonnumeric or nonfinite animation value ${value}`, () => {
    const { bone } = createTestProject();
    addAnimationWithPositionKeyframe(bone, {
      time: 0,
      data_points: [{ x: value, y: 0, z: 0 }],
    });
    expect(() => captureNeteaseProject({
      model: { name: "test_model" },
      centimetersPerUnit: 1,
      includeAnimations: true,
    })).toThrow("must be a finite numeric value");
  });
}

test("accepts numeric string keyframe values used by Blockbench", () => {
  const { bone } = createTestProject();
  addAnimationWithPositionKeyframe(bone, {
    time: 0,
    interpolation: "linear",
    data_points: [{ x: "2.5", y: "0", z: "-1" }],
  });
  const captured = captureNeteaseProject({
    model: { name: "test_model" },
    centimetersPerUnit: 2,
    includeAnimations: true,
  });
  expect(captured.document.animations[0].data.tracks[0].keyframes[0].pos).toEqual([5, 0, -2]);
});

for (const endRotation of [360, -360]) {
  test(`rejects a ${endRotation}-degree rotation that would lose a full turn`, () => {
    const { bone } = createTestProject();
    const rotation = [
      { time: 0, data_points: [{ x: 0, y: 0, z: 0 }] },
      { time: 1, data_points: [{ x: 0, y: endRotation, z: 0 }] },
    ];
    animations.push({
      uuid: "animation-spin",
      name: "animation.test_model.spin",
      length: 1,
      getShortName: () => "spin",
      animators: { [bone.uuid]: { keyframes: rotation, rotation, position: [], scale: [], getElement: () => bone } },
    });
    expect(() => captureNeteaseProject({
      model: { name: "test_model" },
      centimetersPerUnit: 1,
      includeAnimations: true,
    })).toThrow("Subdivide the rotation into linear keyframes with steps of 180 degrees or less");
  });
}

test("accepts rotation steps of exactly 180 degrees", () => {
  const { bone } = createTestProject();
  const rotation = [
    { time: 0, data_points: [{ x: 0, y: 0, z: 0 }] },
    { time: 0.5, data_points: [{ x: 0, y: 180, z: 0 }] },
    { time: 1, data_points: [{ x: 0, y: 360, z: 0 }] },
  ];
  animations.push({
    uuid: "animation-spin",
    name: "animation.test_model.spin",
    length: 1,
    getShortName: () => "spin",
    animators: { [bone.uuid]: { keyframes: rotation, rotation, position: [], scale: [], getElement: () => bone } },
  });
  const captured = captureNeteaseProject({
    model: { name: "test_model" },
    centimetersPerUnit: 1,
    includeAnimations: true,
  });
  expect(captured.document.animations[0].data.tracks[0].keyframes).toHaveLength(3);
});
