import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAllToolDefinitions } from "../lib/factories";
import { bedrockExportAnimationsParameters, registerExportTools } from "../server/tools/export";

const originals = new Map<string, PropertyDescriptor | undefined>();
const animations = [
  { uuid: "a-1", name: "animation.test.rebirth", length: 0.75, loop: false },
  { uuid: "a-2", name: "animation.test.idle", length: 2, loop: true },
  { uuid: "a-3", name: "animation.test.unused", length: 1, loop: false },
];
const compiledWith: string[][] = [];
const permissions: Array<{ scope?: string }> = [];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-export-"));

function install(name: string, value: unknown): void {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, value });
}

async function run(args: Record<string, unknown>): Promise<string> {
  const tool = getAllToolDefinitions().bedrock_export_animations;
  const parsed = await bedrockExportAnimationsParameters.parseAsync(args);
  const result = await tool.execute(parsed);
  if (typeof result !== "string") throw new Error("Expected a JSON text response.");
  return result;
}

beforeAll(() => {
  install("Project", { uuid: "project" });
  install("Animation", { all: animations });
  install("PathModule", path);
  install("autoStringify", (value: unknown) => JSON.stringify(value));
  install("requireNativeModule", (_name: string, options: { scope?: string }) => {
    permissions.push(options);
    return fs;
  });
  install("AnimationCodec", {
    codecs: {
      bedrock: {
        compileFile(list: typeof animations) {
          compiledWith.push(list.map((a) => a.name));
          return {
            format_version: "1.8.0",
            animations: Object.fromEntries(list.map((a) => [a.name, { animation_length: a.length }])),
          };
        },
      },
    },
  });
  if (!getAllToolDefinitions().bedrock_export_animations) registerExportTools();
});

afterAll(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("compiles only the named animations through the native codec and writes the file", async () => {
  const target = path.join(root, "pack", "animations", "phoenix.json");
  const result = JSON.parse(await run({ animations: ["animation.test.rebirth", "a-2"], path: target }));
  expect(compiledWith.at(-1)).toEqual(["animation.test.rebirth", "animation.test.idle"]);
  expect(result.path).toBe(path.resolve(target));
  expect(result.format_version).toBe("1.8.0");
  expect(result.animations.map((a: { uuid: string }) => a.uuid)).toEqual(["a-1", "a-2"]);
  expect(permissions.at(-1)?.scope).toBe(path.dirname(path.resolve(target)));
  const written = JSON.parse(fs.readFileSync(target, "utf8"));
  expect(Object.keys(written.animations)).toEqual(["animation.test.rebirth", "animation.test.idle"]);
});

test("rejects relative, non-JSON, unknown and duplicate requests before writing", async () => {
  const calls = compiledWith.length;
  await expect(run({ animations: ["a-1"], path: "animations/out.json" })).rejects.toThrow("absolute");
  await expect(run({ animations: ["a-1"], path: path.join(root, "out.txt") })).rejects.toThrow(".json");
  await expect(run({ animations: ["animation.test.missing"], path: path.join(root, "out.json") })).rejects.toThrow("not found");
  await expect(run({ animations: ["a-1", "a-1"], path: path.join(root, "out.json") })).rejects.toThrow("unique");
  await expect(run({ animations: [], path: path.join(root, "out.json") })).rejects.toThrow();
  expect(compiledWith.length).toBe(calls);
  expect(fs.existsSync(path.join(root, "out.json"))).toBe(false);
});
