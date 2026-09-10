/** State used by modeling tools that Blockbench does not save per project tab. */
const paintControls = [
  "slider_brush_size", "slider_brush_opacity", "slider_brush_softness", "brush_shape",
  "fill_mode", "blend_mode", "draw_shape_type", "copy_brush_mode", "mirror_painting",
  "pixel_perfect_drawing", "color_erase_mode",
];
const paintOptions = ["mirror_painting", "mirror_painting_options", "lock_alpha", "erase_mode"];
const paintSettings = [
  "paint_side_restrict", "brush_opacity_modifier", "brush_size_modifier",
  "paint_with_stylus_only", "pick_color_opacity", "pick_combined_color",
];
type Values = Record<string, unknown>;
type ValueHolder = { value?: unknown; setValue?: (value: unknown) => void };
interface EditorState {
  controls: Values;
  toolSettings: Record<string, Values>;
  tool?: string;
  mode?: string;
  painter: Values;
  settings: Values;
  colors?: [string, string];
  timeline?: { time: number; speed: number; selected: string[] };
  previews: Array<{ id: string; angle: AnglePreset; locked: number | null; fov: number; aspectRatio?: number; sideViewTarget?: number[] }>;
}

function copy<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export function captureEditorState(): EditorState {
  const state: EditorState = { controls: {}, toolSettings: {}, painter: {}, settings: {}, previews: [] };
  if (typeof BarItems !== "undefined") {
    for (const [id, item] of Object.entries(BarItems)) {
      const tool = item as unknown as { tool_settings?: Values };
      if (tool.tool_settings) state.toolSettings[id] = copy(tool.tool_settings);
    }
    for (const id of paintControls) {
      const item = BarItems[id] as ValueHolder | undefined;
      if (item && "value" in item) state.controls[id] = copy(item.value);
    }
  }
  if (typeof Toolbox !== "undefined") state.tool = Toolbox.selected?.id;
  if (typeof Modes !== "undefined" && typeof Modes.id === "string") state.mode = Modes.id;
  if (typeof Painter !== "undefined") {
    const painter = Painter as unknown as Values;
    for (const key of paintOptions) if (key in painter) state.painter[key] = copy(painter[key]);
  }
  if (typeof settings !== "undefined") {
    for (const key of paintSettings) if (settings[key]) state.settings[key] = copy(settings[key].value);
  }
  if (typeof ColorPanel !== "undefined") state.colors = [ColorPanel.get(false), ColorPanel.get(true)];
  if (typeof Timeline !== "undefined") state.timeline = {
    time: Timeline.time, speed: Timeline.playback_speed,
    selected: Timeline.selected?.map(keyframe => keyframe.uuid) ?? [],
  };
  if (typeof Preview !== "undefined") {
    state.previews = Preview.all.map(preview => ({
      id: preview.id,
      locked: preview.angle,
      fov: preview.camPers.fov,
      aspectRatio: (preview as unknown as { aspect_ratio?: number }).aspect_ratio,
      sideViewTarget: (preview as unknown as { side_view_target?: THREE.Vector3 }).side_view_target?.toArray(),
      angle: {
        position: preview.camera.position.toArray() as ArrayVector3,
        target: preview.controls.target.toArray() as ArrayVector3,
        projection: preview.isOrtho ? "orthographic" : "perspective",
        zoom: preview.camOrtho.zoom,
      },
    }));
  }
  return state;
}

export async function restoreEditorState(snapshot: unknown): Promise<void> {
  const state = snapshot as EditorState | undefined;
  if (!state) return;
  if (state.mode && typeof Modes !== "undefined" && typeof Project !== "undefined" && Project && Modes.id !== state.mode) {
    Modes.options[state.mode]?.select();
  }
  // Project and mode selection schedule animation/selection resets in Vue.
  const vue = (globalThis as unknown as { Vue?: { nextTick(callback: () => void): void } }).Vue;
  if (vue) await new Promise<void>(resolve => vue.nextTick(resolve));
  if (typeof BarItems !== "undefined") {
    for (const [id, values] of Object.entries(state.toolSettings)) {
      const tool = BarItems[id] as unknown as { tool_settings?: Values } | undefined;
      if (!tool?.tool_settings) continue;
      for (const key of Object.keys(tool.tool_settings)) delete tool.tool_settings[key];
      Object.assign(tool.tool_settings, copy(values));
    }
    const selectedTool = state.tool ? BarItems[state.tool] as unknown as { select?: () => void } : undefined;
    selectedTool?.select?.();
    for (const [id, value] of Object.entries(state.controls)) {
      const item = BarItems[id] as ValueHolder | undefined;
      if (item) {
        // Avoid onChange handlers: restoring a workspace must not persist settings.
        item.value = copy(value);
      }
    }
  }
  if (typeof Painter !== "undefined") Object.assign(Painter, copy(state.painter));
  if (typeof settings !== "undefined") {
    for (const [key, value] of Object.entries(state.settings)) {
      if (settings[key]) settings[key].value = copy(value) as Setting["value"];
    }
  }
  if (state.colors && typeof ColorPanel !== "undefined") {
    ColorPanel.set(state.colors[0], false, true);
    ColorPanel.set(state.colors[1], true, true);
  }
  if (state.timeline && typeof Timeline !== "undefined") {
    Timeline.pause();
    Timeline.playback_speed = state.timeline.speed;
    Timeline.setTime(state.timeline.time);
    if (Timeline.keyframes && Timeline.selected) {
      const selected = new Set(state.timeline.selected);
      const keyframes = Timeline.keyframes.filter(keyframe => selected.has(keyframe.uuid));
      for (const keyframe of Timeline.keyframes) keyframe.selected = selected.has(keyframe.uuid);
      Timeline.selected.splice(0, Timeline.selected.length, ...keyframes);
      if (typeof updateKeyframeSelection !== "undefined") updateKeyframeSelection();
    }
    if (typeof Modes !== "undefined" && Modes.animate && typeof Animator !== "undefined") {
      Animator.preview();
    }
  }
  if (typeof Preview !== "undefined") {
    for (const saved of state.previews) {
      const preview = Preview.all.find(item => item.id === saved.id);
      if (preview) {
        const angle = { ...saved.angle, aspect_ratio: saved.aspectRatio };
        preview.loadAnglePreset(angle);
        (preview as unknown as { aspect_ratio?: number }).aspect_ratio = saved.aspectRatio;
        preview.setFOV(saved.fov);
        if (saved.sideViewTarget) {
          (preview as unknown as { side_view_target?: THREE.Vector3 }).side_view_target?.fromArray(saved.sideViewTarget);
        }
        if (saved.locked !== null) preview.setLockedAngle(saved.locked);
        // Locked views may replace the position/target while applying a preset.
        preview.camera.position.fromArray(saved.angle.position);
        if (saved.angle.target) preview.controls.target.fromArray(saved.angle.target);
        preview.camOrtho.zoom = saved.angle.zoom ?? 1;
        preview.camera.updateProjectionMatrix();
        preview.controls.update();
      }
    }
  }
}
