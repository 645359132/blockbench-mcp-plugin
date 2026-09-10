import { expect, test } from "bun:test";
import { captureEditorState, restoreEditorState } from "../lib/editorState";

test("restores detached paint and locked-camera state without replacing native vectors", async () => {
  const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
  function install(name: string, value: unknown): void {
    originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  class Vector {
    constructor(public values: number[]) {}
    toArray(): number[] { return [...this.values]; }
    fromArray(values: number[]): this { this.values = [...values]; return this; }
  }
  const sideTarget = new Vector([1, 2, 3]);
  const camera = { position: new Vector([20, 30, 40]), updateProjectionMatrix() {} };
  const preview = {
    id: "main", angle: 2, aspect_ratio: 1.5, side_view_target: sideTarget,
    camera, camPers: { fov: 65 }, camOrtho: { zoom: 3 }, isOrtho: true,
    controls: { target: new Vector([4, 5, 6]), update() {} },
    loadAnglePreset() { this.camPers.fov = 45; this.aspect_ratio = 0; },
    setFOV(fov: number) { this.camPers.fov = fov; },
    setLockedAngle(angle: number) { this.angle = angle; camera.position.fromArray([0, 0, 0]); },
  };
  const brushTool = { tool_settings: { brush_size: 7 } };
  const brush = { value: 7, get() { return brushTool.tool_settings.brush_size; } };
  const mirrorOptions = { x: true, texture_center: [16, 16] };
  const painter = { mirror_painting_options: mirrorOptions, lock_alpha: false };
  let renderedTime = -1;
  const keyframe = { uuid: "owned-keyframe", selected: true };
  const timeline = {
    time: 0.5, playback_speed: 100, selected: [keyframe], keyframes: [keyframe],
    pause() {}, setTime(time: number) { this.time = time; },
  };
  try {
    install("Preview", { all: [preview] });
    install("BarItems", { slider_brush_size: brush, brush_tool: brushTool });
    install("Painter", painter);
    install("Timeline", timeline);
    install("Modes", { animate: true });
    install("Animator", { preview() { renderedTime = timeline.time; } });
    const first = captureEditorState();
    brush.value = 99;
    brushTool.tool_settings.brush_size = 99;
    timeline.selected.length = 0;
    keyframe.selected = false;
    mirrorOptions.texture_center[0] = 128;
    sideTarget.fromArray([90, 91, 92]);
    camera.position.fromArray([99, 99, 99]);
    timeline.time = 1.25;
    const second = captureEditorState();
    await restoreEditorState(first);
    expect(brush.value).toBe(7);
    expect(brush.get()).toBe(7);
    expect(timeline.selected).toEqual([keyframe]);
    expect(keyframe.selected).toBe(true);
    expect(painter.mirror_painting_options.texture_center).toEqual([16, 16]);
    expect(preview.side_view_target).toBe(sideTarget);
    expect(sideTarget.toArray()).toEqual([1, 2, 3]);
    expect(camera.position.toArray()).toEqual([20, 30, 40]);
    expect(preview.controls.target.toArray()).toEqual([4, 5, 6]);
    expect(preview.camPers.fov).toBe(65);
    expect(preview.aspect_ratio).toBe(1.5);
    expect(renderedTime).toBe(0.5);
    await restoreEditorState(second);
    expect(brush.value).toBe(99);
    expect(brush.get()).toBe(99);
    expect(timeline.selected).toEqual([]);
    expect(keyframe.selected).toBe(false);
    expect(painter.mirror_painting_options.texture_center).toEqual([128, 16]);
    expect(sideTarget.toArray()).toEqual([90, 91, 92]);
    expect(renderedTime).toBe(1.25);
  } finally {
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
