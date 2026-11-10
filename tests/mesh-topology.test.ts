import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { getAllToolDefinitions } from "../lib/factories";
import { registerMeshTools } from "../server/tools/mesh";

const originals = new Map<string, PropertyDescriptor | undefined>();
const meshes: TestMesh[] = [];
const autoUvTargets: TestMesh[][] = [];
const undoEvents: string[] = [];
let undoFinishElements: TestMesh[] = [];
const texture = { uuid: "texture-uuid", id: "0", name: "atlas" };
const project = { uuid: "mesh-project", selected: true, textures: [texture] };

class TestMeshFace {
  vertices: string[];
  uv: Record<string, [number, number]>;
  texture?: string;

  constructor(_mesh: TestMesh, values: Partial<TestMeshFace>) {
    this.vertices = values.vertices ?? [];
    this.uv = values.uv ?? {};
    this.texture = values.texture;
  }
}

class TestMesh {
  static all = meshes;
  static selected: TestMesh[] = [];
  uuid = `mesh-${meshes.length}`;
  name = "";
  origin: [number, number, number] = [0, 0, 0];
  rotation: [number, number, number] = [0, 0, 0];
  shading = "flat";
  parent: unknown = "root";
  vertices: Record<string, [number, number, number]> = {};
  faces: Record<string, TestMeshFace> = {};
  preview_controller = { updateGeometry() {}, updateUV() {} };

  constructor(values: Partial<TestMesh>) {
    Object.assign(this, values);
  }

  init() {
    meshes.push(this);
    return this;
  }

  addVertices(...vertices: [number, number, number][]) {
    return vertices.map((vertex) => {
      const key = `v${Object.keys(this.vertices).length}`;
      this.vertices[key] = vertex;
      return key;
    });
  }

  addFaces(...faces: TestMeshFace[]) {
    return faces.map((face) => {
      const key = `f${Object.keys(this.faces).length}`;
      this.faces[key] = face;
      return key;
    });
  }

  addTo(parent: unknown) {
    this.parent = parent;
    return this;
  }

  getArmature() {
    return undefined;
  }
}

function install(name: string, value: unknown): void {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, value });
}

async function placeMesh(args: Record<string, unknown>) {
  const tool = getAllToolDefinitions().place_mesh;
  return tool.execute(await tool.parameters.parseAsync(args));
}

beforeAll(() => {
  install("Project", project);
  install("ModelProject", { all: [project] });
  install("Texture", { all: [texture], getDefault: () => texture });
  install("Mesh", TestMesh);
  install("MeshFace", TestMeshFace);
  install("getAllGroups", () => []);
  install("Undo", {
    initEdit() { undoEvents.push("init"); },
    finishEdit(_message: string, aspects?: { elements?: TestMesh[] }) {
      undoFinishElements = aspects?.elements ?? [];
      undoEvents.push("finish");
    },
  });
  install("Canvas", { updateAll() {}, updateView() {} });
  install("UVEditor", {
    getMappableElements() { return TestMesh.selected; },
    setAutoSize(this: { getMappableElements(): TestMesh[] }, _event: unknown, _silent: boolean, faceKeys: string[]) {
      const targets: TestMesh[] = this.getMappableElements();
      autoUvTargets.push([...targets]);
      undoEvents.push("auto_uv");
      for (const mesh of targets) {
        for (const faceKey of faceKeys) {
          const face = mesh.faces[faceKey];
          for (const vertexKey of face.vertices) {
            const position = mesh.vertices[vertexKey];
            face.uv[vertexKey] = [position[0], position[1]];
          }
        }
      }
    },
  });
  if (!getAllToolDefinitions().place_mesh) registerMeshTools();
});

beforeEach(() => {
  meshes.length = 0;
  TestMesh.selected.length = 0;
  autoUvTargets.length = 0;
  undoEvents.length = 0;
  undoFinishElements = [];
});

afterAll(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("place_mesh creates indexed topology and returns stable key mappings", async () => {
  const result = await getAllToolDefinitions().place_mesh.execute({
    elements: [
      {
        name: "triangle",
        position: [1, 2, 3],
        rotation: [0, 45, 0],
        scale: [2, 2, 2],
        shading: "smooth",
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        faces: [{
          vertices: [0, 1, 2],
          uv: [[0, 0], [16, 0], [0, 16]],
        }],
      },
    ],
    texture: "atlas",
    group: "root",
  });

  expect(JSON.parse(result as string)).toEqual([{
    name: "triangle",
    uuid: "mesh-0",
    vertex_keys: ["v0", "v1", "v2"],
    face_keys: ["f0"],
    scale_baked_into_vertices: true,
  }]);
  expect(meshes[0]!.origin).toEqual([1, 2, 3]);
  expect(meshes[0]!.rotation).toEqual([0, 45, 0]);
  expect(meshes[0]!.vertices.v1).toEqual([2, 0, 0]);
  expect(meshes[0]!.faces.f0.vertices).toEqual(["v0", "v1", "v2"]);
  expect(meshes[0]!.faces.f0.texture).toBe(texture.uuid);
});

test("place_mesh rejects bad topology before creating an element", async () => {
  await expect(getAllToolDefinitions().place_mesh.execute({
    elements: [{
      name: "broken",
      vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      faces: [{ vertices: [0, 1, 3] }],
    }],
    group: "root",
  })).rejects.toThrow("missing vertex index 3");
  expect(meshes).toHaveLength(0);
});

test("place_mesh maps omitted UVs when no mesh is selected inside its undo edit", async () => {
  await placeMesh({
    elements: [{
      name: "auto-uv",
      vertices: [[0, 0, 0], [4, 0, 0], [0, 8, 0]],
      faces: [{ vertices: [0, 1, 2] }],
    }],
  });

  expect(autoUvTargets).toEqual([[meshes[0]]]);
  expect(meshes[0].faces.f0.uv).toEqual({ v0: [0, 0], v1: [4, 0], v2: [0, 8] });
  expect(TestMesh.selected).toEqual([]);
  expect(undoEvents).toEqual(["init", "auto_uv", "finish"]);
  expect(undoFinishElements).toEqual([meshes[0]]);
});

test("place_mesh maps only new faces while preserving selected meshes and explicit UVs", async () => {
  const selected = new TestMesh({ name: "existing" }).init();
  selected.addVertices([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  selected.addFaces(new TestMeshFace(selected, {
    vertices: ["v0", "v1", "v2"],
    uv: { v0: [10, 10], v1: [20, 10], v2: [10, 20] },
  }));
  TestMesh.selected.push(selected);
  const originalUv = structuredClone(selected.faces.f0.uv);
  const explicitUv = [[2, 2], [6, 2], [2, 6]];

  await placeMesh({
    elements: [{
      name: "new-auto-uv",
      vertices: [[0, 0, 0], [4, 0, 0], [0, 8, 0]],
      faces: [{ vertices: [0, 1, 2] }, { vertices: [0, 2, 1], uv: explicitUv }],
    }],
  });

  expect(autoUvTargets).toEqual([[meshes[1]]]);
  expect(meshes[1].faces.f0.uv).toEqual({ v0: [0, 0], v1: [4, 0], v2: [0, 8] });
  expect(meshes[1].faces.f1.uv).toEqual({ v0: [2, 2], v2: [6, 2], v1: [2, 6] });
  expect(selected.faces.f0.uv).toEqual(originalUv);
  expect(TestMesh.selected).toEqual([selected]);
  expect((globalThis as any).UVEditor.getMappableElements()).toEqual([selected]);
});
