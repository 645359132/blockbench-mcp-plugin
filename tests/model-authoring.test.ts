import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { getAllToolDefinitions } from "../lib/factories";
import { registerCubesTools } from "../server/tools/cubes";
import { registerAnimationTools } from "../server/tools/animation";

const originals = new Map<string, PropertyDescriptor | undefined>();
const texture = { uuid: "atlas-texture", name: "atlas", id: "0" };
const cubes: TestCube[] = [];
interface TestAnimation {
  name: string;
  animators?: Record<string, TestBoneAnimator>;
  select(): void;
}
interface TestKeyframe {
  time: number;
  data_points: Array<{ x: number; y: number; z: number }>;
  animator: TestBoneAnimator;
}
class TestBoneAnimator {
  position: TestKeyframe[] = [];
  rotation: TestKeyframe[] = [];
  scale: TestKeyframe[] = [];
  constructor(public uuid: string, public animation: TestAnimation, public name: string) {}
}
class TestRigBone {
  static animator = TestBoneAnimator;
  constructor(public uuid: string, public name: string) {}
}
const animations: TestAnimation[] = [];
const groups: Array<{ uuid: string; name: string }> = [];
const rigBones: TestRigBone[] = [];
const importedKeyframes: TestKeyframe[] = [];
let selectedAnimation: string | null = null;
let selectedClip: TestAnimation | null = null;
let timelineTime = 0;
const renderEvents: string[] = [];
const project = { uuid: "test-project", selected: true, textures: [texture] };

class TestCube {
  box_uv = true;
  uuid = "test-cube";
  name = "";
  faces = Object.fromEntries(["north", "south", "east", "west", "up", "down"].map(face => {
    const data = { uv: [0, 0, 16, 16], texture: null as string | null, extend(values: object) { Object.assign(this, values); } };
    return [face, data];
  }));
  constructor(values: object) { Object.assign(this, values); cubes.push(this); }
  init() { return this; }
  addTo() {}
  applyTexture() {}
  mapAutoUV() {}
}

function install(name: string, value: unknown) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, value });
}

beforeAll(() => {
  install("Project", project);
  install("ModelProject", { all: [project] });
  install("Texture", { all: [texture], getDefault: () => texture });
  install("Cube", TestCube);
  install("getAllGroups", () => []);
  install("Undo", { initEdit() {}, finishEdit() {} });
  install("Canvas", { updateAll() {}, withoutGizmos(callback: () => void) { callback(); } });
  install("Preview", { selected: {
    render() { renderEvents.push(`render:${timelineTime}`); },
    canvas: { toDataURL: () => "data:image/png;base64,aGVsbG8=" },
  } });
  install("Timeline", { setTime(time: number) { timelineTime = time; } });
  install("Group", { all: groups });
  install("Armature", { all: [{ getAllBones: () => rigBones }] });
  install("BoneAnimator", TestBoneAnimator);
  install("Animation", { all: animations, get selected() { return selectedClip ?? animations.find(a => a.name === selectedAnimation); } });
  install("Animator", { loadFile(file: { content: string }) {
    const clips: TestAnimation[] = [];
    const content = JSON.parse(file.content).animations as Record<string, {
      bones: Record<string, Partial<Record<"position" | "rotation" | "scale", Record<string, number[]>>>>;
    }>;
    for (const [name, data] of Object.entries(content)) {
      const animators: Record<string, TestBoneAnimator> = {};
      const clip: TestAnimation = {
        name, animators,
        select() { selectedAnimation = name; selectedClip = this; },
      };
      for (const [boneName, channels] of Object.entries(data.bones)) {
        const host = groups.find(group => group.name.toLowerCase() === boneName.toLowerCase());
        const uuid = host?.uuid ?? `orphan-${Object.keys(animators).length}`;
        const animator = new TestBoneAnimator(uuid, clip, boneName);
        animators[uuid] = animator;
        for (const channel of ["position", "rotation", "scale"] as const) {
          for (const [time, values] of Object.entries(channels[channel] ?? {})) {
            const keyframe = {
              time: Number(time),
              data_points: [{ x: values[0], y: values[1], z: values[2] }],
              animator,
            };
            animator[channel].push(keyframe);
            importedKeyframes.push(keyframe);
          }
        }
      }
      animations.push(clip);
      clips.push(clip);
    }
    return clips;
  }, preview() { renderEvents.push(`preview:${timelineTime}`); } });
  if (!getAllToolDefinitions().place_cube) registerCubesTools();
  if (!getAllToolDefinitions().create_animation) registerAnimationTools();
});

beforeEach(() => {
  cubes.length = 0;
  animations.length = 0;
  groups.length = 0;
  rigBones.length = 0;
  importedKeyframes.length = 0;
  selectedAnimation = null;
  selectedClip = null;
  timelineTime = 0;
  renderEvents.length = 0;
});

afterAll(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("explicit atlas UVs disable box UV and bind the named texture", async () => {
  const uv = [0.05, 0.05, 3.95, 3.95];
  await getAllToolDefinitions().place_cube.execute({
    elements: [{ name: "effect-plane", from: [-20, -20, 0], to: [20, 20, 0] }],
    texture: "atlas", faces: [{ face: "north", uv }],
  });
  expect(cubes[0].box_uv).toBe(false);
  expect(cubes[0].faces.north.uv).toEqual(uv);
  expect(cubes[0].faces.north.texture).toBe(texture.uuid);
});

test("automatic UV mapping retains the format's normal box UV default", async () => {
  await getAllToolDefinitions().place_cube.execute({ elements: [{ name: "auto" }], faces: true });
  expect(cubes[0].box_uv).toBe(true);
});

test("creating a clip selects it for subsequent scoped timeline playback", async () => {
  await getAllToolDefinitions().create_animation.execute({
    name: "test.cast", loop: false, animation_length: 1,
    bones: { root: [{ time: 0, scale: [0.1, 0.1, 0.1] }, { time: 1, scale: [1, 1, 1] }] },
  });
  expect(selectedAnimation).toBe("animation.test.cast");
});

test("creating an armature clip rehomes native orphan keyframes onto its rig bones", async () => {
  rigBones.push(new TestRigBone("rig-bone", "wing"));
  await getAllToolDefinitions().create_animation.execute({
    name: "test.flap", loop: false, animation_length: 1,
    bones: { wing: [{ time: 1, rotation: [0, 0, 45] }, { time: 0, rotation: [0, 0, 0] }] },
  });

  const clip = animations[0];
  const target = clip.animators!["rig-bone"];
  expect(Object.keys(clip.animators!)).toEqual(["rig-bone"]);
  expect(target).toBeInstanceOf(TestBoneAnimator);
  expect(target.rotation.map(keyframe => keyframe.time)).toEqual([0, 1]);
  expect(target.rotation[1]).toBe(importedKeyframes.find(keyframe => keyframe.time === 1)!);
  expect(target.rotation[1].data_points).toEqual([{ x: 0, y: 0, z: 45 }]);
  expect(importedKeyframes.every(keyframe => keyframe.animator === target)).toBe(true);
});

test("creating an armature clip preserves animation tracks bound to real groups", async () => {
  groups.push({ uuid: "real-group", name: "wing" });
  rigBones.push(new TestRigBone("rig-bone", "wing"));
  await getAllToolDefinitions().create_animation.execute({
    name: "test.group", loop: false,
    bones: { wing: [{ time: 0, rotation: [0, 30, 0] }] },
  });

  const clip = animations[0];
  expect(Object.keys(clip.animators!)).toEqual(["real-group"]);
  expect(clip.animators!["real-group"].rotation[0]).toBe(importedKeyframes[0]);
});

test("creating a clip selects the imported instance when another clip has the same name", async () => {
  const existing: TestAnimation = {
    name: "animation.test.cast", animators: {},
    select() { selectedClip = this; },
  };
  animations.push(existing);
  await getAllToolDefinitions().create_animation.execute({
    name: "test.cast", loop: false, bones: {},
  });

  expect(selectedClip).toBe(animations[1]);
  expect(selectedClip).not.toBe(existing);
});

test("seek by clip ID captures the animated frame before workspace restoration", async () => {
  animations.push({ name: "animation.test.cast", select() { selectedAnimation = this.name; } });
  const result = await getAllToolDefinitions().animation_timeline.execute({
    action: "set_time", animation_id: "animation.test.cast", time: 0.6, capture_frame: true,
  });
  expect(selectedAnimation).toBe("animation.test.cast");
  expect(renderEvents).toEqual(["preview:0.6", "render:0.6"]);
  expect(result).toEqual({ content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] });
});
