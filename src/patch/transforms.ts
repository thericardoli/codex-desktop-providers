import {
  parse,
  type Node,
  type MethodDefinition,
  type FunctionDeclaration,
  type Identifier,
  type ObjectPattern,
} from "acorn";
import { full } from "acorn-walk";
import MagicString from "magic-string";

const BINDING = "__codexDesktopProviders";
const IMPORT = `import * as ${BINDING} from "./codex-desktop-providers/index.js";\n`;

function ast(source: string) {
  return parse(source, { ecmaVersion: "latest", sourceType: "module" });
}

function single<T>(nodes: T[], description: string): T {
  if (nodes.length !== 1) {
    throw new Error(
      `Expected exactly one ${description}; found ${nodes.length}`,
    );
  }
  return nodes[0]!;
}

function identifiers(params: readonly Node[]): string[] {
  return params.map((param) => {
    if (param.type !== "Identifier")
      throw new Error("Unexpected upstream parameter shape");
    return (param as Identifier).name;
  });
}

function ensureUnpatched(source: string): void {
  if (source.includes(BINDING))
    throw new Error("Asset already contains the patch binding");
}

export function transformShared(source: string): string {
  ensureUnpatched(source);
  const methods: MethodDefinition[] = [];
  full(ast(source), (node) => {
    if (node.type === "MethodDefinition")
      methods.push(node as MethodDefinition);
  });
  const named = (name: string) =>
    methods.filter(
      (node) =>
        node.key.type === "Identifier" &&
        (node.key as Identifier).name === name,
    );
  const sender = single(
    named("sendRequest").filter((node) =>
      source
        .slice(node.start, node.end)
        .includes("AppServerRequestClient is missing a message dispatcher"),
    ),
    "renderer request dispatcher",
  );
  const warmer = single(
    named("prewarmThreadStart").filter((node) =>
      source.slice(node.start, node.end).includes("this.dispatchMessage"),
    ),
    "renderer prewarm dispatcher",
  );
  const defaults = single(
    named("setDefaultModelConfig").filter((node) =>
      source
        .slice(node.start, node.end)
        .includes("this.defaultTurnConfig.writeModel"),
    ),
    "default-model writer",
  );
  const output = new MagicString(source);
  const body = (node: MethodDefinition) =>
    source.slice(node.value.body!.start + 1, node.value.body!.end - 1);
  const [method, params, options] = identifiers(sender.value.params);
  if (!method || !params || !options)
    throw new Error("Unexpected request dispatcher arity");
  output.overwrite(
    sender.value.body!.start + 1,
    sender.value.body!.end - 1,
    `return ${BINDING}.intercept(this,${method},${params},${options},async(${method},${params},${options})=>{${body(sender)}});`,
  );
  const [warmParams] = identifiers(warmer.value.params);
  if (!warmParams) throw new Error("Unexpected prewarm dispatcher arity");
  output.overwrite(
    warmer.value.body!.start + 1,
    warmer.value.body!.end - 1,
    `return ${BINDING}.prewarm(this,${warmParams},async(${warmParams})=>{${body(warmer)}});`,
  );
  const [model, effort] = identifiers(defaults.value.params);
  if (!model || !effort)
    throw new Error("Unexpected default-model writer arity");
  output.overwrite(
    defaults.value.body!.start + 1,
    defaults.value.body!.end - 1,
    `return ${BINDING}.writeDefault(this.requestClient,${model},${effort},async()=>{${body(defaults)}});`,
  );
  output.prepend(IMPORT);
  const result = output.toString();
  ast(result);
  return result;
}

/** Only expose entries tagged by our local registry; keep official gating intact. */
export function transformPicker(source: string): string {
  ensureUnpatched(source);
  const matches: { node: FunctionDeclaration; model: string }[] = [];
  const selectors: { node: FunctionDeclaration; models: string }[] = [];
  full(ast(source), (node) => {
    if (node.type !== "FunctionDeclaration") return;
    const fn = node as FunctionDeclaration;
    const param = fn.params[0];
    if (param?.type !== "ObjectPattern") return;
    const properties = (param as ObjectPattern).properties;
    const keys = properties.flatMap((property) =>
      property.type === "Property" && property.key.type === "Identifier"
        ? [property.key.name]
        : [],
    );
    if (
      ["models", "enabledReasoningEfforts", "defaultModel"].every((key) =>
        keys.includes(key),
      ) &&
      source
        .slice(fn.body.start, fn.body.end)
        .includes(".supportedReasoningEfforts")
    ) {
      for (const property of properties) {
        if (
          property.type === "Property" &&
          property.key.type === "Identifier" &&
          property.key.name === "models" &&
          property.value.type === "Identifier"
        )
          selectors.push({ node: fn, models: property.value.name });
      }
    }
    if (
      ![
        "model",
        "availableModels",
        "useHiddenModels",
        "hasConfiguredModelCatalog",
        "apiKeyDaybreakSupported",
      ].every((key) => keys.includes(key))
    )
      return;
    // The selector and filter both destructure catalog fields. Only the filter
    // inspects the single model's access program bounds.
    if (
      !source
        .slice(fn.body.start, fn.body.end)
        .includes(".availableAccessPrograms?.cyber")
    )
      return;
    for (const property of properties) {
      if (
        property.type === "Property" &&
        property.key.type === "Identifier" &&
        property.key.name === "model" &&
        property.value.type === "Identifier"
      ) {
        matches.push({ node: fn, model: property.value.name });
      }
    }
  });
  const { node, model } = single(matches, "model visibility predicate");
  const output = new MagicString(source);
  const selector = single(selectors, "reasoning-effort selector");
  const selectorBody = source.slice(
    selector.node.body.start + 1,
    selector.node.body.end - 1,
  );
  output.overwrite(
    selector.node.body.start + 1,
    selector.node.body.end - 1,
    `return ${BINDING}.restorePickerEfforts((()=>{${selectorBody}})(),${selector.models});`,
  );
  output.appendLeft(
    node.body.start + 1,
    `if(${BINDING}.isRegisteredModel(${model}))return !${model}.hidden;`,
  );
  output.prepend(IMPORT);
  const result = output.toString();
  ast(result);
  return result;
}
