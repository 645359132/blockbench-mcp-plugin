/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";
import {
  meshSchema,
  meshIdOptionalSchema,
  meshIdSchema,
  textureIdOptionalSchema,
  groupIdOptionalSchema,
  vector3Schema,
  meshSelectionModeEnum,
  selectionActionEnum,
} from "@/lib/zodObjects";
import { STATUS_EXPERIMENTAL, STATUS_STABLE } from "@/lib/constants";
import { getProjectTexture, getMeshOrSelected, findMeshOrThrow } from "@/lib/util";

type MeshInput = z.infer<typeof meshSchema>;

interface CreatedMeshResult {
  mesh: Mesh;
  vertexKeys: string[];
  faceKeys: string[];
}

// ============================================================================
// Mesh Tool Parameter Schemas
// ============================================================================

export const placeMeshParameters = z.object({
  elements: z
    .array(meshSchema)
    .min(1)
    .describe("Array of meshes to place."),
  texture: textureIdOptionalSchema.describe("Texture ID or name to apply to the mesh."),
  group: groupIdOptionalSchema.describe("Group/bone to which the mesh belongs."),
});

export const getMeshParameters = z.object({
  mesh_id: meshIdOptionalSchema,
  include_weights: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include non-zero armature weights for each vertex."),
});

export const extrudeMeshParameters = z.object({
  mesh_id: meshIdOptionalSchema,
  distance: z.number().default(1).describe("Distance to extrude."),
  mode: z
    .enum(["faces", "edges", "vertices"])
    .default("faces")
    .describe("What to extrude: faces, edges, or vertices."),
});

export const subdivideMeshParameters = z.object({
  mesh_id: meshIdOptionalSchema,
  cuts: z
    .number()
    .min(1)
    .max(10)
    .default(1)
    .describe("Number of subdivision cuts to make."),
});

export const createSphereParameters = z.object({
  elements: z
    .array(
      z.object({
        name: z.string().describe("Name of the sphere."),
        position: vector3Schema.describe("Position of the sphere center."),
        diameter: z
          .number()
          .min(1)
          .max(64)
          .default(16)
          .describe("Diameter of the sphere."),
        sides: z
          .number()
          .min(3)
          .max(48)
          .default(12)
          .describe(
            "Number of horizontal divisions (affects sphere quality)."
          ),
        rotation: vector3Schema
          .optional()
          .default([0, 0, 0])
          .describe("Rotation of the sphere."),
        align_edges: z
          .boolean()
          .optional()
          .default(true)
          .describe("Whether to align edges for better geometry."),
      })
    )
    .min(1)
    .describe("Array of spheres to create."),
  texture: textureIdOptionalSchema.describe("Texture ID or name to apply to the sphere."),
  group: groupIdOptionalSchema.describe("Group/bone to which the sphere belongs."),
});

export const selectMeshElementsParameters = z.object({
  mesh_id: meshIdSchema.describe("ID or name of the mesh to select elements from."),
  mode: meshSelectionModeEnum.describe("Selection mode."),
  elements: z
    .array(
      z.union([
        z
          .string()
          .describe("Vertex key, edge as 'vkey1-vkey2', or face key"),
        z.number().describe("Index of the element"),
      ])
    )
    .optional()
    .describe("Specific elements to select. If not provided, selects all."),
  action: selectionActionEnum
    .default("select")
    .describe(
      "Selection action: select (replace), add, remove, or toggle."
    ),
});

export const moveMeshVerticesParameters = z.object({
  mesh_id: meshIdOptionalSchema,
  offset: vector3Schema.describe("Offset to move vertices by [x, y, z]."),
  vertices: z
    .array(z.string())
    .optional()
    .describe(
      "Specific vertex keys to move. If not provided, moves all selected vertices."
    ),
});

export const deleteMeshElementsParameters = z.object({
  mesh_id: meshIdOptionalSchema,
  mode: z
    .enum(["vertices", "edges", "faces"])
    .default("faces")
    .describe("What to delete: vertices, edges, or faces."),
  keep_vertices: z
    .boolean()
    .default(false)
    .describe("When deleting faces/edges, whether to keep the vertices."),
});

export const mergeMeshVerticesParameters = z.object({
  mesh_id: meshIdSchema,
  threshold: z
    .number()
    .min(0)
    .max(10)
    .default(0.1)
    .describe("Maximum distance between vertices to merge."),
  selected_only: z
    .boolean()
    .default(true)
    .describe("Whether to only merge selected vertices."),
});

export const createMeshFaceParameters = z.object({
  mesh_id: meshIdOptionalSchema,
  vertices: z
    .array(z.string())
    .min(3)
    .max(4)
    .describe("Vertex keys to create face from. Must be 3 or 4 vertices."),
  texture: textureIdOptionalSchema.describe("Texture ID or name to apply to the new face."),
});

export const createCylinderParameters = z.object({
  elements: z
    .array(
      z.object({
        name: z.string(),
        position: vector3Schema,
        height: z.number().min(1).max(64).default(16),
        diameter: z.number().min(1).max(64).default(16),
        sides: z.number().min(3).max(64).default(12),
        rotation: vector3Schema.optional().default([0, 0, 0]),
        capped: z.boolean().optional().default(true),
      })
    )
    .min(1),
  texture: textureIdOptionalSchema,
  group: groupIdOptionalSchema,
});

export const knifeToolParameters = z.object({
  mesh_id: meshIdSchema.describe("ID or name of the mesh to cut."),
  points: z
    .array(
      z.object({
        position: vector3Schema.describe("3D position of the cut point."),
        face: z
          .string()
          .optional()
          .describe("Face key to attach the point to."),
      })
    )
    .min(2)
    .describe("Points defining the cut path."),
});

// ============================================================================
// Mesh Tool Docs
// ============================================================================

export const meshToolDocs: ToolSpec[] = [
  {
    name: "place_mesh",
    description:
      "Creates one or more polygon meshes from indexed vertices and triangle/quad faces. Supports transforms, UVs, per-face textures, and an optional parent group.",
    annotations: {
      title: "Place Mesh",
      destructiveHint: true,
    },
    parameters: placeMeshParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "extrude_mesh",
    description: "Extrudes selected faces or edges of a mesh.",
    annotations: {
      title: "Extrude Mesh",
      destructiveHint: true,
    },
    parameters: extrudeMeshParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "subdivide_mesh",
    description: "Subdivides selected faces of a mesh to create more geometry.",
    annotations: {
      title: "Subdivide Mesh",
      destructiveHint: true,
    },
    parameters: subdivideMeshParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "create_sphere",
    description:
      "Creates a sphere mesh at the specified position with the given parameters. The sphere is created as a mesh with vertices and faces using spherical coordinates.",
    annotations: {
      title: "Create Sphere",
      destructiveHint: true,
    },
    parameters: createSphereParameters,
    status: STATUS_STABLE,
  },
  {
    name: "select_mesh_elements",
    description:
      "Selects vertices, edges, or faces of a mesh for manipulation.",
    annotations: {
      title: "Select Mesh Elements",
      destructiveHint: true,
    },
    parameters: selectMeshElementsParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "move_mesh_vertices",
    description: "Moves selected vertices of a mesh by the specified offset.",
    annotations: {
      title: "Move Mesh Vertices",
      destructiveHint: true,
    },
    parameters: moveMeshVerticesParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "delete_mesh_elements",
    description: "Deletes selected vertices, edges, or faces from a mesh.",
    annotations: {
      title: "Delete Mesh Elements",
      destructiveHint: true,
    },
    parameters: deleteMeshElementsParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "merge_mesh_vertices",
    description:
      "Merges vertices that are within a specified distance of each other.",
    annotations: {
      title: "Merge Mesh Vertices",
      destructiveHint: true,
    },
    parameters: mergeMeshVerticesParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "create_mesh_face",
    description: "Creates a new face from selected vertices.",
    annotations: {
      title: "Create Mesh Face",
      destructiveHint: true,
    },
    parameters: createMeshFaceParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "create_cylinder",
    description: "Creates one or more cylinder meshes with optional end caps.",
    annotations: { title: "Create Cylinder", destructiveHint: true },
    parameters: createCylinderParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "knife_tool",
    description: "Uses the knife tool to cut custom edges into mesh faces.",
    annotations: {
      title: "Knife Tool",
      destructiveHint: true,
    },
    parameters: knifeToolParameters,
    status: STATUS_EXPERIMENTAL,
  },
  {
    name: "get_mesh",
    description:
      "Returns complete mesh topology, transforms, per-face UVs and textures, plus optional armature weights. Vertex indices match the order returned in vertices.",
    annotations: {
      title: "Get Mesh",
      readOnlyHint: true,
    },
    parameters: getMeshParameters,
    status: STATUS_STABLE,
  },
];

// ============================================================================
// Registration
// ============================================================================

export function registerMeshTools() {
  createTool(meshToolDocs[0].name, {
    ...meshToolDocs[0],
    async execute({ elements, texture, group }, context) {
      const reportProgress = context?.reportProgress ?? (() => undefined);
      const total = elements.length;

      const projectTexture = texture ? getProjectTexture(texture) : Texture.getDefault();

      if (texture && !projectTexture) {
        throw new Error(`No texture found for "${texture}".`);
      }

      for (const element of elements) {
        for (const [faceIndex, inputFace] of element.faces.entries()) {
          if (inputFace.uv && inputFace.uv.length !== inputFace.vertices.length) {
            throw new Error(
              `Mesh "${element.name}" face ${faceIndex} has ${inputFace.vertices.length} vertices but ${inputFace.uv.length} UV coordinates.`
            );
          }
          if (new Set(inputFace.vertices).size !== inputFace.vertices.length) {
            throw new Error(
              `Mesh "${element.name}" face ${faceIndex} references the same vertex more than once.`
            );
          }
          for (const vertexIndex of inputFace.vertices) {
            if (vertexIndex >= element.vertices.length) {
              throw new Error(
                `Mesh "${element.name}" face ${faceIndex} references missing vertex index ${vertexIndex}.`
              );
            }
          }
          if (inputFace.texture && !getProjectTexture(inputFace.texture)) {
            throw new Error(
              `Mesh "${element.name}" face ${faceIndex} references missing texture "${inputFace.texture}".`
            );
          }
        }
      }

      // @ts-expect-error getAllGroups is a utility function that returns all groups in the project
      const groups = getAllGroups();
      const outlinerGroup = group === "root"
        ? "root"
        : groups.find((g: Group) => g.name === group || g.uuid === group) ?? "root";

      Undo.initEdit({
        elements: [],
        outliner: true,
        collections: [],
      });

      const meshes: CreatedMeshResult[] = elements.map((element: MeshInput, progress: number) => {
        const mesh = new Mesh({
          name: element.name,
          vertices: {},
          origin: element.position as [number, number, number],
          rotation: element.rotation as [number, number, number],
          shading: element.shading,
        }).init();

        const scaledVertices = element.vertices.map((vertex: number[]) => [
          vertex[0] * element.scale[0],
          vertex[1] * element.scale[1],
          vertex[2] * element.scale[2],
        ] as ArrayVector3);
        const vertexKeys = mesh.addVertices(...scaledVertices);
        const faceKeys: string[] = [];
        const autoUvFaceKeys: string[] = [];

        for (const [faceIndex, inputFace] of element.faces.entries()) {
          const faceVertexKeys = inputFace.vertices.map((vertexIndex: number) => {
            return vertexKeys[vertexIndex]!;
          });
          const faceTexture = inputFace.texture
            ? getProjectTexture(inputFace.texture)
            : projectTexture;
          const uv = Object.fromEntries(
            faceVertexKeys.map((vertexKey: string, uvIndex: number) => [
              vertexKey,
              inputFace.uv?.[uvIndex] ?? [0, 0],
            ])
          ) as Record<string, ArrayVector2>;
          const [faceKey] = mesh.addFaces(
            new MeshFace(mesh, {
              vertices: faceVertexKeys,
              uv,
              texture: faceTexture?.uuid,
            })
          );
          faceKeys.push(faceKey);
          if (!inputFace.uv) autoUvFaceKeys.push(faceKey);
        }

        mesh.addTo(outlinerGroup);
        if (autoUvFaceKeys.length > 0) {
          // Native auto UV uses its receiver's mapping targets. Scope the call
          // to this mesh while preserving the editor's current selection.
          const scopedUvEditor = Object.create(UVEditor);
          scopedUvEditor.getMappableElements = () => [mesh];
          scopedUvEditor.setAutoSize(null, true, autoUvFaceKeys);
        }

        reportProgress({
          progress,
          total,
        });

        return {
          mesh,
          vertexKeys,
          faceKeys,
        };
      });

      Undo.finishEdit("Agent placed meshes", {
        elements: meshes.map(({ mesh }) => mesh),
        outliner: true,
        collections: [],
      });
      Canvas.updateAll();

      return await Promise.resolve(
        JSON.stringify(
          meshes.map(({ mesh, vertexKeys, faceKeys }: CreatedMeshResult) => ({
            name: mesh.name,
            uuid: mesh.uuid,
            vertex_keys: vertexKeys,
            face_keys: faceKeys,
            scale_baked_into_vertices: true,
          })),
          null,
          2
        )
      );
    },
  }, meshToolDocs[0].status);

  createTool(meshToolDocs[1].name, {
    ...meshToolDocs[1],
    async execute({ mesh_id, distance, mode }) {
      const mesh = getMeshOrSelected(mesh_id);

      // Use the extrude tool
      const tool = BarItems.extrude_mesh_selection;

      if (!tool) {
        throw new Error(`Extrude tool for ${mode} not found.`);
      }

      // @ts-ignore
      tool.click({}, distance);

      return `Extruded ${mode} of mesh "${mesh.name}" by ${distance} units`;
    },
  }, meshToolDocs[1].status);

  createTool(meshToolDocs[2].name, {
    ...meshToolDocs[2],
    async execute({ mesh_id, cuts }) {
      const mesh = getMeshOrSelected(mesh_id);

      // Use the loop cut tool with subdivision
      const tool = BarItems.loop_cut;
      if (!tool) {
        throw new Error("Loop cut tool not found.");
      }

      // @ts-ignore
      tool.click({}, undefined, undefined, cuts);

      return `Subdivided mesh "${mesh.name}" with ${cuts} cuts`;
    },
  }, meshToolDocs[2].status);

  createTool(meshToolDocs[3].name, {
    ...meshToolDocs[3],
    async execute({ elements, texture, group }, context) {
      const reportProgress = context?.reportProgress ?? (() => undefined);
      Undo.initEdit({
        elements: [],
        outliner: true,
        collections: [],
      });
      const total = elements.length;

      const projectTexture = texture
        ? getProjectTexture(texture)
        : Texture.getDefault();

      if (!projectTexture) {
        throw new Error(`No texture found for "${texture}".`);
      }

      // @ts-expect-error getAllGroups is a utility function that returns all groups in the project
      const groups = getAllGroups();
      const outlinerGroup = group === "root"
        ? "root"
        : groups.find((g: Group) => g.name === group || g.uuid === group) ?? "root";

      const spheres = elements.map((element: z.infer<typeof createSphereParameters>["elements"][number], progress: number) => {
        const mesh = new Mesh({
          name: element.name,
          vertices: {},
          origin: element.position as [number, number, number],
          rotation: (element.rotation || [0, 0, 0]) as [
            number,
            number,
            number
          ],
        }).init();

        // Create sphere vertices using spherical coordinates
        const radius = element.diameter / 2;
        const sides = Math.round(element.sides / 2) * 2; // Ensure even number for symmetry

        // Add top and bottom vertices
        const [bottom] = mesh.addVertices([0, -radius, 0]);
        const [top] = mesh.addVertices([0, radius, 0]);

        const rings: string[][] = [];
        const off_ang = element.align_edges ? 0.5 : 0;

        // Create rings of vertices
        for (let i = 0; i < element.sides; i++) {
          const circle_x = Math.sin(
            ((i + off_ang) / element.sides) * Math.PI * 2
          );
          const circle_z = Math.cos(
            ((i + off_ang) / element.sides) * Math.PI * 2
          );

          const vertices: string[] = [];
          for (let j = 1; j < sides / 2; j++) {
            const slice_x = Math.sin((j / sides) * Math.PI * 2) * radius;
            const x = circle_x * slice_x;
            const y = Math.cos((j / sides) * Math.PI * 2) * radius;
            const z = circle_z * slice_x;
            vertices.push(...mesh.addVertices([x, y, z]));
          }
          rings.push(vertices);
        }

        // Create faces
        for (let i = 0; i < element.sides; i++) {
          const this_ring = rings[i];
          const next_ring = rings[i + 1] || rings[0];

          for (let j = 0; j < sides / 2; j++) {
            if (j == 0) {
              // Connect to top vertex
              mesh.addFaces(
                new MeshFace(mesh, {
                  vertices: [this_ring[j], next_ring[j], top],
                  uv: {},
                })
              );
              continue;
            }

            if (!this_ring[j]) {
              // Connect to bottom vertex
              mesh.addFaces(
                new MeshFace(mesh, {
                  vertices: [next_ring[j - 1], this_ring[j - 1], bottom],
                  uv: {},
                })
              );
              continue;
            }

            // Connect ring segments
            mesh.addFaces(
              new MeshFace(mesh, {
                vertices: [
                  this_ring[j],
                  next_ring[j],
                  this_ring[j - 1],
                  next_ring[j - 1],
                ],
                uv: {},
              })
            );
          }
        }

        mesh.addTo(outlinerGroup);
        if (projectTexture) {
          mesh.applyTexture(projectTexture);
        }

        reportProgress({
          progress,
          total,
        });

        return mesh;
      });

      Undo.finishEdit("Agent created spheres");
      Canvas.updateAll();

      return await Promise.resolve(
        JSON.stringify(
          spheres.map(
            (sphere: Mesh) => `Added sphere ${sphere.name} with ID ${sphere.uuid}`
          )
        )
      );
    },
  }, meshToolDocs[3].status);

  createTool(meshToolDocs[4].name, {
    ...meshToolDocs[4],
    async execute({ mesh_id, mode, elements, action }) {
      const mesh = findMeshOrThrow(mesh_id);

      Undo.initEdit({
        elements: [mesh],
        selection: true,
        collections: [],
      });

      // Set selection mode
      // @ts-expect-error Selection mode setter available at runtime
      BarItems.selection_mode.set(mode);
      const selection = (Project?.mesh_selection[mesh.uuid] ??
      {
        vertices: [],
        edges: [],
        faces: [],
      }) as {
        vertices: string[];
        edges: unknown[];
        faces: string[];
      };

      if (action === "select") {
        // Clear existing selection
        selection.vertices = [];
        selection.edges.length = 0;
        selection.faces = [];
      }

      if (!elements || elements.length === 0) {
        // Select all elements of the specified type
        if (mode === "vertex") {
          selection.vertices = Object.keys(mesh.vertices);
        } else if (mode === "face") {
          selection.faces = Object.keys(mesh.faces);
        } else if (mode === "edge") {
          // Collect all unique edges from faces
          const allEdges: [string, string][] = [];
          const seen = new Set<string>();
          for (const fkey in mesh.faces) {
            const face = mesh.faces[fkey];
            const edges = (face.getEdges() as unknown as [string, string][]);
            for (const [a, b] of edges) {
              const key = a < b ? `${a}-${b}` : `${b}-${a}`;
              if (!seen.has(key)) {
                seen.add(key);
                allEdges.push([a, b]);
              }
            }
          }
          const selEdges = selection.edges as unknown as [string, string][];
          selEdges.length = 0;
          selEdges.push(...allEdges);
        }
      } else {
        // Select specific elements
        elements.forEach((element: string | number) => {
          if (mode === "vertex") {
            const vkey = String(element);
            if (action === "add" || action === "select") {
              if (!selection.vertices.includes(vkey)) {
                selection.vertices.push(vkey);
              }
            } else if (action === "remove") {
              selection.vertices = selection.vertices.filter((k) => k !== vkey);
            } else if (action === "toggle") {
              if (selection.vertices.includes(vkey)) {
                selection.vertices = selection.vertices.filter((k) => k !== vkey);
              } else {
                selection.vertices.push(vkey);
              }
            }
          } else if (mode === "face") {
            const fkey = String(element);
            if (action === "add" || action === "select") {
              if (!selection.faces.includes(fkey)) {
                selection.faces.push(fkey);
              }
            } else if (action === "remove") {
              selection.faces = selection.faces.filter((k) => k !== fkey);
            } else if (action === "toggle") {
              if (selection.faces.includes(fkey)) {
                selection.faces = selection.faces.filter((k) => k !== fkey);
              } else {
                selection.faces.push(fkey);
              }
            }
          } else if (mode === "edge") {
            // Parse edge format "vkey1-vkey2"
            const edgeParts = String(element).split("-");
            if (edgeParts.length === 2) {
              const edge: [string, string] = [edgeParts[0], edgeParts[1]];
              const selEdges = selection.edges as unknown as [string, string][];
              if (action === "add" || action === "select") {
                selEdges.push(edge);
              } else if (action === "remove") {
                const filtered = selEdges.filter(
                  (e) =>
                    !(e[0] === edge[0] && e[1] === edge[1]) &&
                    !(e[0] === edge[1] && e[1] === edge[0])
                );
                selEdges.length = 0;
                selEdges.push(...filtered);
              } else if (action === "toggle") {
                const exists = selEdges.some(
                  (e) =>
                    (e[0] === edge[0] && e[1] === edge[1]) ||
                    (e[0] === edge[1] && e[1] === edge[0])
                );
                if (exists) {
                  const filtered = selEdges.filter(
                    (e) =>
                      !(e[0] === edge[0] && e[1] === edge[1]) &&
                      !(e[0] === edge[1] && e[1] === edge[0])
                  );
                  selEdges.length = 0;
                  selEdges.push(...filtered);
                } else {
                  selEdges.push(edge);
                }
              }
            }
          }
        });
      }

      mesh.select();
      Canvas.updateView({
        elements: [mesh],
        selection: true,
      });

      Undo.finishEdit("Select mesh elements");

      return JSON.stringify({
        mesh: mesh.name,
        mode,
        selected: {
          vertices: selection.vertices.length,
          edges: selection.edges.length,
          faces: selection.faces.length,
        },
      });
    },
  }, meshToolDocs[4].status);

  createTool(meshToolDocs[5].name, {
    ...meshToolDocs[5],
    async execute({ mesh_id, offset, vertices }) {
      const mesh = getMeshOrSelected(mesh_id);

      Undo.initEdit({
        elements: [mesh],
        element_aspects: {
          geometry: true,
          uv: true,
          faces: true,
        },
      } as any); // Blockbench runtime supports element_aspects; current public types omit it.

      const verticesToMove = vertices || mesh.getSelectedVertices();

      verticesToMove.forEach((vkey: string) => {
        if (mesh.vertices[vkey]) {
          mesh.vertices[vkey][0] += offset[0];
          mesh.vertices[vkey][1] += offset[1];
          mesh.vertices[vkey][2] += offset[2];
        }
      });

      mesh.preview_controller.updateGeometry(mesh);

      Undo.finishEdit("Move mesh vertices");
      Canvas.updateView({
        elements: [mesh],
        element_aspects: {
          geometry: true,
          uv: true,
          faces: true,
        },
      });

      return `Moved ${verticesToMove.length} vertices of mesh "${mesh.name}"`;
    },
  }, meshToolDocs[5].status);

  createTool(meshToolDocs[6].name, {
    ...meshToolDocs[6],
    async execute({ mesh_id, mode, keep_vertices }) {
      const mesh = getMeshOrSelected(mesh_id);

      // Use the delete tool
      const tool = BarItems.delete_mesh_selection;
      if (!tool) {
        throw new Error("Delete mesh selection tool not found.");
      }

      // @ts-ignore
      tool.click({}, keep_vertices);

      return `Deleted selected ${mode} from mesh "${mesh.name}"`;
    },
  }, meshToolDocs[6].status);

  createTool(meshToolDocs[7].name, {
    ...meshToolDocs[7],
    async execute({ mesh_id, threshold, selected_only }) {
      const mesh = findMeshOrThrow(mesh_id);

      Undo.initEdit({
        elements: [mesh],
        element_aspects: {
          geometry: true,
          uv: true,
          faces: true,
        },
      } as any); // Blockbench runtime supports element_aspects; current public types omit it.

      const verticesToCheck = selected_only
        ? mesh.getSelectedVertices()
        : Object.keys(mesh.vertices);

      let mergedCount = 0;
      const mergeMap: Record<string, string> = {};

      // Find vertices to merge
      for (let i = 0; i < verticesToCheck.length; i++) {
        const vkey1 = verticesToCheck[i];
        if (mergeMap[vkey1]) continue;

        for (let j = i + 1; j < verticesToCheck.length; j++) {
          const vkey2 = verticesToCheck[j];
          if (mergeMap[vkey2]) continue;

          const v1 = mesh.vertices[vkey1];
          const v2 = mesh.vertices[vkey2];
          const distance = Math.sqrt(
            (v1[0] - v2[0]) ** 2 + (v1[1] - v2[1]) ** 2 + (v1[2] - v2[2]) ** 2
          );

          if (distance <= threshold) {
            mergeMap[vkey2] = vkey1;
            mergedCount++;
          }
        }
      }

      // Apply merges
      Object.entries(mergeMap).forEach(([oldKey, newKey]) => {
        // Update faces
        for (const fkey in mesh.faces) {
          const face = mesh.faces[fkey];
          const index = face.vertices.indexOf(oldKey);
          if (index !== -1) {
            face.vertices[index] = newKey;
            face.uv[newKey] = face.uv[oldKey] || [0, 0];
            delete face.uv[oldKey];
          }
        }
        // Remove merged vertex
        delete mesh.vertices[oldKey];
      });

      mesh.preview_controller.updateGeometry(mesh);

      Undo.finishEdit("Merge mesh vertices");
      Canvas.updateView({
        elements: [mesh],
        element_aspects: {
          geometry: true,
          uv: true,
          faces: true,
        },
      });

      return `Merged ${mergedCount} vertices in mesh "${mesh.name}"`;
    },
  }, meshToolDocs[7].status);

  createTool(meshToolDocs[8].name, {
    ...meshToolDocs[8],
    async execute({ mesh_id, vertices, texture }) {
      const mesh = getMeshOrSelected(mesh_id);

      Undo.initEdit({
        elements: [mesh],
        element_aspects: {
          geometry: true,
          uv: true,
          faces: true,
        },
      } as any); // Blockbench runtime supports element_aspects; current public types omit it.

      // Create the face
      const face = new MeshFace(mesh, {
        vertices,
        texture: texture ? getProjectTexture(texture)?.uuid : undefined,
      });

      const [faceKey] = mesh.addFaces(face);

      // Auto UV the new face
      UVEditor.setAutoSize(null, true, [faceKey]);

      mesh.preview_controller.updateGeometry(mesh);
      mesh.preview_controller.updateUV(mesh);

      Undo.finishEdit("Create mesh face");
      Canvas.updateView({
        elements: [mesh],
        element_aspects: {
          geometry: true,
          uv: true,
          faces: true,
        },
      });

      return `Created face with ${vertices.length} vertices in mesh "${mesh.name}"`;
    },
  }, meshToolDocs[8].status);

  createTool(meshToolDocs[9].name, {
    ...meshToolDocs[9],
    async execute({ elements, texture, group }, context) {
      const reportProgress = context?.reportProgress ?? (() => undefined);
      Undo.initEdit({ elements: [], outliner: true, collections: [] });
      const total = elements.length;
      const projectTexture = texture
        ? getProjectTexture(texture)
        : Texture.getDefault();
      if (!projectTexture) throw new Error(`Texture "${texture}" not found.`);
      // @ts-expect-error getAllGroups is a utility function that returns all groups in the project
      const groups = getAllGroups();
      const outlinerGroup = group === "root"
        ? "root"
        : groups.find((g: Group) => g.name === group || g.uuid === group) ?? "root";
      const cylinders = elements.map((element: z.infer<typeof createCylinderParameters>["elements"][number], progress: number) => {
        const mesh = new Mesh({
          name: element.name,
          vertices: {},
          origin: element.position as [number, number, number],
          rotation: (element.rotation || [0, 0, 0]) as [
            number,
            number,
            number
          ],
        }).init();
        const radius = element.diameter / 2;
        const height = element.height;
        const sides = Math.round(element.sides);
        // centres for the caps
        const topCenter = mesh.addVertices([0, height / 2, 0])[0];
        const bottomCenter = mesh.addVertices([0, -height / 2, 0])[0];
        const topRing: any[] = [];
        const bottomRing: any[] = [];
        for (let i = 0; i < sides; i++) {
          const ang = (i / sides) * Math.PI * 2;
          const x = Math.cos(ang) * radius;
          const z = Math.sin(ang) * radius;
          topRing.push(mesh.addVertices([x, height / 2, z])[0]);
          bottomRing.push(mesh.addVertices([x, -height / 2, z])[0]);
        }
        for (let i = 0; i < sides; i++) {
          const next = (i + 1) % sides;
          // side face
          mesh.addFaces(
            new MeshFace(mesh, {
              vertices: [
                bottomRing[i],
                bottomRing[next],
                topRing[next],
                topRing[i],
              ],
              uv: {},
            })
          );
          if (element.capped) {
            // top cap (triangle fan)
            mesh.addFaces(
              new MeshFace(mesh, {
                vertices: [topRing[i], topRing[next], topCenter],
                uv: {},
              })
            );
            // bottom cap
            mesh.addFaces(
              new MeshFace(mesh, {
                vertices: [bottomRing[next], bottomRing[i], bottomCenter],
                uv: {},
              })
            );
          }
        }
        mesh.addTo(outlinerGroup);
        if (projectTexture) mesh.applyTexture(projectTexture);
        reportProgress({ progress, total });
        return mesh;
      });
      Undo.finishEdit("Agent created cylinders");
      Canvas.updateAll();
      return JSON.stringify(
        cylinders.map((c: Mesh) => `Added cylinder ${c.name} (ID ${c.uuid})`)
      );
    },
  }, meshToolDocs[9].status);

  createTool(meshToolDocs[10].name, {
    ...meshToolDocs[10],
    async execute({ mesh_id, points }) {
      const mesh = findMeshOrThrow(mesh_id);

      Undo.initEdit({
        elements: [mesh],
        element_aspects: {
          geometry: true,
          uv: true,
          faces: true,
        },
      } as any); // Blockbench runtime supports element_aspects; current public types omit it.

      // Create knife tool context
      // @ts-ignore
      const knifeContext = new KnifeToolContext(mesh);

      // Add points to the knife path
      points.forEach((point: z.infer<typeof knifeToolParameters>["points"][number]) => {
        knifeContext.points.push({
          position: new (globalThis as any).THREE.Vector3(...point.position),
          fkey: point.face,
          type: point.face ? "face" : "edge",
        });
      });

      // Apply the knife cut
      knifeContext.apply();

      Undo.finishEdit("Knife cut mesh");
      Canvas.updateView({
        elements: [mesh],
        element_aspects: {
          geometry: true,
          uv: true,
          faces: true,
        },
      });

      return `Applied knife cut to mesh "${mesh.name}" with ${points.length} points`;
    },
  }, meshToolDocs[10].status);

  createTool(meshToolDocs[11].name, {
    ...meshToolDocs[11],
    async execute({ mesh_id, include_weights }) {
      const mesh = getMeshOrSelected(mesh_id);
      const vertexEntries = Object.entries(mesh.vertices);
      const vertexIndex = new Map(vertexEntries.map(([key], index) => [key, index]));
      const armature = mesh.getArmature?.();
      const bones = armature?.getAllBones?.() ?? [];

      const vertices = vertexEntries.map(([key, position], index) => {
        const weights = include_weights
          ? bones.flatMap((bone: ArmatureBone) => {
              const weight = bone.getVertexWeight(mesh, key);
              return weight > 0
                ? [{ bone_uuid: bone.uuid, bone_name: bone.name, weight }]
                : [];
            })
          : undefined;
        return { index, key, position, ...(include_weights ? { weights } : {}) };
      });

      const faces = Object.entries(mesh.faces).map(([key, face]) => {
        const texture = face.texture
          ? Texture.all.find(
              (candidate: Texture) =>
                candidate.uuid === face.texture || String(candidate.id) === String(face.texture)
            )
          : undefined;
        return {
          key,
          vertices: face.vertices.map((vertexKey) => ({
            index: vertexIndex.get(vertexKey),
            key: vertexKey,
            uv: face.uv[vertexKey] ?? null,
          })),
          texture: texture
            ? { uuid: texture.uuid, id: texture.id, name: texture.name }
            : face.texture || null,
        };
      });

      return JSON.stringify(
        {
          mesh: {
            uuid: mesh.uuid,
            name: mesh.name,
            origin: mesh.origin,
            rotation: mesh.rotation,
            shading: mesh.shading,
            parent:
              mesh.parent && typeof mesh.parent === "object"
                ? { uuid: mesh.parent.uuid, name: mesh.parent.name, type: mesh.parent.type }
                : mesh.parent,
            armature: armature
              ? { uuid: armature.uuid, name: armature.name }
              : null,
          },
          vertices,
          faces,
        },
        null,
        2
      );
    },
  }, meshToolDocs[11].status);
}
