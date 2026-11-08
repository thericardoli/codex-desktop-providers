import {
  parse,
  type Node,
  type MethodDefinition,
  type FunctionDeclaration,
  type Identifier,
} from "acorn";
import { full } from "acorn-walk";
import MagicString from "magic-string";

const BINDING = "__codexDesktopProviders";
const DEFAULT_IMPORT = "./codex-desktop-providers/index.js";

export const PATCH_POINTS = [
  "request",
  "prewarm",
  "defaults",
  "visibility",
  "efforts",
] as const;
export type PatchPoint = (typeof PATCH_POINTS)[number];

export interface PatchEdit {
  point: PatchPoint;
  start: number;
  end: number;
  replacement: string;
}

function ast(source: string) {
  return parse(source, { ecmaVersion: "latest", sourceType: "module" });
}

function identifiers(params: readonly Node[]): string[] {
  return params.map((param) => {
    if (param.type !== "Identifier")
      throw new Error("Unexpected upstream parameter shape");
    return (param as Identifier).name;
  });
}

/** Avoid parsing unrelated vendor modules. These are code markers, not filenames. */
export function isPatchCandidate(source: string): boolean {
  return (
    source.includes("AppServerRequestClient is missing a message dispatcher") ||
    (source.includes("prewarmThreadStart") &&
      source.includes("dispatchMessage")) ||
    (source.includes("setDefaultModelConfig") &&
      source.includes("defaultTurnConfig")) ||
    (source.includes("availableAccessPrograms") &&
      source.includes("availableModels")) ||
    (source.includes("supportedReasoningEfforts") &&
      source.includes("enabledReasoningEfforts") &&
      source.includes("defaultModel"))
  );
}

/** Locate all relevant edits in one module; uniqueness is checked across modules. */
export function findPatchEdits(source: string): PatchEdit[] {
  const edits: PatchEdit[] = [];
  full(ast(source), (node) => {
    if (node.type === "MethodDefinition") {
      const method = node as MethodDefinition;
      if (method.key.type !== "Identifier" || !method.value.body) return;
      const name = method.key.name;
      const body = source.slice(
        method.value.body.start + 1,
        method.value.body.end - 1,
      );
      const replace = (point: PatchPoint, replacement: string) =>
        edits.push({
          point,
          start: method.value.body!.start + 1,
          end: method.value.body!.end - 1,
          replacement,
        });
      if (
        name === "sendRequest" &&
        body.includes("AppServerRequestClient is missing a message dispatcher")
      ) {
        const [request, params, options] = identifiers(method.value.params);
        if (!request || !params || !options)
          throw new Error("Unexpected request dispatcher arity");
        replace(
          "request",
          `return ${BINDING}.intercept(this,${request},${params},${options},async(${request},${params},${options})=>{${body}});`,
        );
      }
      if (
        name === "prewarmThreadStart" &&
        body.includes("this.dispatchMessage")
      ) {
        const [params] = identifiers(method.value.params);
        if (!params) throw new Error("Unexpected prewarm dispatcher arity");
        replace(
          "prewarm",
          `return ${BINDING}.prewarm(this,${params},async(${params})=>{${body}});`,
        );
      }
      if (
        name === "setDefaultModelConfig" &&
        body.includes("this.defaultTurnConfig.writeModel")
      ) {
        const [model, effort] = identifiers(method.value.params);
        if (!model || !effort)
          throw new Error("Unexpected default-model writer arity");
        replace(
          "defaults",
          `return ${BINDING}.writeDefault(this.requestClient,${model},${effort},async()=>{${body}});`,
        );
      }
    }
    if (node.type !== "FunctionDeclaration") return;
    const fn = node as FunctionDeclaration;
    const param = fn.params[0];
    if (param?.type !== "ObjectPattern") return;
    const properties = param.properties;
    const keys = properties.flatMap((property) =>
      property.type === "Property" && property.key.type === "Identifier"
        ? [property.key.name]
        : [],
    );
    const body = source.slice(fn.body.start + 1, fn.body.end - 1);
    const boundName = (key: string) => {
      for (const property of properties) {
        if (
          property.type === "Property" &&
          property.key.type === "Identifier" &&
          property.key.name === key &&
          property.value.type === "Identifier"
        )
          return property.value.name;
      }
      throw new Error(`Unexpected upstream binding for ${key}`);
    };
    if (
      ["models", "enabledReasoningEfforts", "defaultModel"].every((key) =>
        keys.includes(key),
      ) &&
      body.includes(".supportedReasoningEfforts")
    ) {
      edits.push({
        point: "efforts",
        start: fn.body.start + 1,
        end: fn.body.end - 1,
        replacement: `return ${BINDING}.restorePickerEfforts((()=>{${body}})(),${boundName("models")});`,
      });
    }
    // Only the visibility predicate inspects the single model's access programs.
    if (
      [
        "model",
        "availableModels",
        "useHiddenModels",
        "hasConfiguredModelCatalog",
        "apiKeyDaybreakSupported",
      ].every((key) => keys.includes(key)) &&
      body.includes(".availableAccessPrograms?.cyber")
    ) {
      const model = boundName("model");
      // A startup catalog normally makes every listed model visible. Only our
      // explicitly routed external entries may use that exception; official
      // entries must still pass the original native account/entitlement logic.
      const configuredCatalog = boundName("hasConfiguredModelCatalog");
      edits.push({
        point: "visibility",
        start: fn.body.start + 1,
        end: fn.body.start + 1,
        replacement: `if(${BINDING}.isRegisteredModel(${model}))return !${model}.hidden;${configuredCatalog}=false;`,
      });
    }
  });
  return edits;
}

export function applyEdits(
  source: string,
  edits: readonly PatchEdit[],
  runtimeImport = DEFAULT_IMPORT,
): string {
  if (source.includes(BINDING))
    throw new Error("Asset already contains the patch binding");
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1]!.end > sorted[i]!.start)
      throw new Error("Overlapping upstream patch points");
  }
  const output = new MagicString(source);
  for (const edit of sorted) {
    if (edit.start === edit.end)
      output.appendLeft(edit.start, edit.replacement);
    else output.overwrite(edit.start, edit.end, edit.replacement);
  }
  output.prepend(
    `import * as ${BINDING} from ${JSON.stringify(runtimeImport)};\n`,
  );
  const result = output.toString();
  ast(result);
  return result;
}

/** Single-module helpers also used by the focused transformation tests. */
function transform(source: string, points: readonly PatchPoint[]): string {
  if (source.includes(BINDING))
    throw new Error("Asset already contains the patch binding");
  const edits = findPatchEdits(source).filter((edit) =>
    points.includes(edit.point),
  );
  for (const point of points) {
    const count = edits.filter((edit) => edit.point === point).length;
    if (count !== 1)
      throw new Error(
        `Expected exactly one ${point} patch point; found ${count}`,
      );
  }
  return applyEdits(source, edits);
}

export const transformShared = (source: string): string =>
  transform(source, ["request", "prewarm", "defaults"]);
export const transformPicker = (source: string): string =>
  transform(source, ["visibility", "efforts"]);
