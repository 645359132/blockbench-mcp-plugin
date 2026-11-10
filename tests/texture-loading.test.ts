import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { awaitTextureLoad, textureFileDataUrl } from "../lib/textureLoading";
import { getAllToolDefinitions } from "../lib/factories";
import { registerTextureTools } from "../server/tools/texture";

class TestImage {
  onload: HTMLImageElement["onload"] = null;
  onerror: HTMLImageElement["onerror"] = null;
  src = "";
  removeAttribute(name: string): void { if (name === "src") this.src = ""; }
  load(): void { if (this.onload) Reflect.apply(this.onload, this, [new Event("load")]); }
  fail(): void { if (this.onerror) Reflect.apply(this.onerror, this, [new Event("error")]); }
}

const events: string[] = [];
const instances: TestTexture[] = [];
const imageData = "data:image/png;base64,iVBORw==";
let project = { textures: [] as TestTexture[] };
let editingTextures: TestTexture[] = [];
let undoFinished = false;
let undoCancelled = false;

class TestTexture {
  img = new TestImage();
  error = 0;
  source = "";
  width = 16;
  height = 16;
  internal = true;
  layers_enabled = false;
  group?: string;
  pbr_channel?: string;
  stopped = false;
  load_callback?: (texture: TestTexture) => void;
  canvas = { width: 16, height: 16, toDataURL: () => imageData };
  constructor(data: object = {}) {
    Object.assign(this, data);
    if (this.group && ["mer", "height"].includes(this.pbr_channel ?? "")) events.push("scheduled-material");
    this.img.onload = () => {
      events.push("native:start");
      this.load_callback?.(this);
      delete this.load_callback;
      events.push("native:end");
    };
    instances.push(this);
  }
  load(): this { this.img.src = this.source; return this; }
  fromFile(file: { path: string }): this {
    events.push(`from-file:${file.path}`);
    this.internal = false;
    this.source = file.path;
    return this.load();
  }
  fillParticle(): void {}
  updateSource(source: string): void { this.source = source; this.img.src = source; }
  updateLayerChanges(): void {}
  stopWatcher(): void { this.stopped = true; }
  getActiveCanvas() {
    return { ctx: { canvas: this.canvas, clearRect() {}, fillRect() {}, fillStyle: "" } };
  }
  add(): void { project.textures.push(this); events.push("add"); }
  getDataURL(): string { events.push("result"); return this.source; }
}

const originals = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, descriptor: PropertyDescriptor): void {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, ...descriptor });
}

beforeAll(() => {
  install("Project", { get: () => project });
  install("Texture", { value: TestTexture });
  install("TextureGroup", { value: { all: [{
    uuid: "material-uuid", name: "material-name", updateMaterial() { events.push("material"); },
  }] } });
  install("Undo", { value: {
    initEdit(options: { textures: TestTexture[] }) { editingTextures = options.textures; },
    finishEdit() { undoFinished = true; events.push("finish"); },
    cancelEdit() {
      undoCancelled = true;
      project.textures = project.textures.filter(texture => !editingTextures.includes(texture));
    },
  } });
  install("Canvas", { value: { updateAll() { events.push("canvas"); } } });
  install("requireNativeModule", { value: (name: string) => {
    expect(name).toBe("fs");
    return { readFileSync(path: string) { events.push(`read:${path}`); return Buffer.from([137, 80, 78, 71]); } };
  } });
  if (!getAllToolDefinitions().create_texture) registerTextureTools();
});

beforeEach(() => {
  events.length = 0;
  instances.length = 0;
  project = { textures: [] };
  editingTextures = [];
  undoFinished = false;
  undoCancelled = false;
});

afterAll(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("completion waits for native load_callback and the rest of native onload", async () => {
  const texture = new TestTexture();
  let completed = false;
  const pending = awaitTextureLoad(texture, () => texture.load()).then(() => {
    completed = true;
    events.push("complete");
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  texture.img.load();
  expect(completed).toBe(false);
  await pending;
  expect(events).toEqual(["native:start", "native:end", "complete"]);
});

test("preserves native callbacks installed by fromFile during startup", async () => {
  const texture = new TestTexture();
  const pending = awaitTextureLoad(texture, () => {
    texture.load_callback = () => { events.push("native-edit-session"); };
    texture.load();
  });
  texture.img.load();
  await pending;
  expect(events).toEqual(["native:start", "native-edit-session", "native:end"]);
});

test("timeout neutralizes even a captured late image callback before releasing the caller", async () => {
  const texture = new TestTexture();
  const pending = awaitTextureLoad(texture, () => texture.load(), { timeoutMs: 20 });
  const lateLoad = texture.img.onload!;
  await expect(pending).rejects.toThrow("timed out");
  Reflect.apply(lateLoad, texture.img, [new Event("load")]);
  expect(events).toEqual([]);
  expect(texture.img.onload).toBeNull();
  expect(texture.img.onerror).toBeNull();
  expect(texture.load_callback).toBeUndefined();
  expect(texture.img.src).toBe("");
  expect(texture.stopped).toBe(true);
});

test("decode errors and project changes reject before native work can affect another project", async () => {
  const invalid = new TestTexture();
  const failed = awaitTextureLoad(invalid, () => invalid.load());
  invalid.img.fail();
  await expect(failed).rejects.toThrow("decode");
  const switched = new TestTexture();
  const changed = awaitTextureLoad(switched, () => switched.load(), { isCurrentProject: () => false });
  switched.img.load();
  await expect(changed).rejects.toThrow("active project changed");
  expect(events).toEqual([]);
});

test("native failures reject and remove callbacks", async () => {
  const texture = new TestTexture();
  const pending = awaitTextureLoad(texture, () => texture.load());
  texture.error = 1;
  texture.img.load();
  await expect(pending).rejects.toThrow("error 1");
  expect(texture.img.onload).toBeNull();
  expect(texture.stopped).toBe(true);
});

test("file snapshots decode file URLs and read bytes into an internal data URL", () => {
  const readPaths: string[] = [];
  const result = textureFileDataUrl("file:///D:/models/my%20skin.PNG", path => {
    readPaths.push(path);
    return Uint8Array.from([137, 80, 78, 71]);
  });
  expect(readPaths).toEqual(["D:/models/my skin.PNG"]);
  expect(result).toBe(imageData);
  expect(() => textureFileDataUrl("skin.tga", () => new Uint8Array())).toThrow("isolated texture");
});

function createTexture(args: Record<string, unknown>, isolated = true) {
  const context = isolated ? {
    reportProgress() {},
    workspace: { sessionId: "textures", workspaceId: "one", getProjectId: () => "one", bindProject() {}, ownsProject: () => true, releaseProject() {} },
  } : undefined;
  return getAllToolDefinitions().create_texture.execute({ name: "test", width: 32, height: 64, ...args }, context);
}

test("create_texture adds before awaiting and commits only after bitmap processing", async () => {
  const pending = createTexture({});
  const texture = instances[0];
  expect(project.textures).toEqual([texture]);
  expect(texture.canvas.width).toBe(32);
  expect(texture.canvas.height).toBe(64);
  expect(undoFinished).toBe(false);
  expect(events).not.toContain("result");
  texture.img.load();
  await pending;
  expect(events).toEqual(["add", "native:start", "native:end", "result", "canvas", "finish"]);
  expect(undoFinished).toBe(true);
});

test("create_texture snapshots isolated paths and preserves the direct UI file import", async () => {
  const remote = createTexture({ data: "D:/skin.png" });
  const internal = instances[0];
  expect(internal.internal).toBe(true);
  expect(internal.source).toBe(imageData);
  expect(events).toContain("read:D:/skin.png");
  expect(events.some(event => event.startsWith("from-file:"))).toBe(false);
  internal.img.load();
  await remote;
  const local = createTexture({ data: "D:/skin.png" }, false);
  const linked = instances[1];
  expect(linked.internal).toBe(false);
  expect(events).toContain("from-file:D:/skin.png");
  linked.img.load();
  await local;
});

test("create_texture decode failure cancels Undo and removes the newly added texture", async () => {
  const pending = createTexture({ data: imageData });
  const texture = instances[0];
  texture.img.fail();
  await expect(pending).rejects.toThrow("decode");
  expect(undoCancelled).toBe(true);
  expect(undoFinished).toBe(false);
  expect(project.textures).toEqual([]);
  expect(texture.img.onload).toBeNull();
});

test("isolated material names resolve to UUIDs after loading without scheduling a constructor timer", async () => {
  const pending = createTexture({ data: imageData, group: "material-name", pbr_channel: "mer" });
  const texture = instances[0];
  expect(texture.group).toBeUndefined();
  expect(texture.pbr_channel).toBeUndefined();
  texture.img.load();
  await pending;
  expect(texture.group).toBe("material-uuid");
  expect(texture.pbr_channel).toBe("mer");
  expect(events).not.toContain("scheduled-material");
  expect(events.indexOf("material")).toBeGreaterThan(events.indexOf("native:end"));
});
