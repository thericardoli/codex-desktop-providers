import {
  parse,
  type ClassBody,
  type MethodDefinition,
  type Identifier,
  type Node,
  type MemberExpression,
  type CallExpression,
} from "acorn";
import { full } from "acorn-walk";
import { BINDING, type PatchEdit } from "./transforms.js";

function memberPath(node: Node): string | undefined {
  if (node.type === "ThisExpression") return "this";
  if (node.type !== "MemberExpression") return;
  const member = node as MemberExpression;
  const parent = memberPath(member.object);
  const key =
    !member.computed && member.property.type === "Identifier"
      ? member.property.name
      : member.property.type === "Literal" &&
          typeof member.property.value === "string"
        ? member.property.value
        : undefined;
  return parent && key ? `${parent}.${key}` : undefined;
}

function calls(method: MethodDefinition, path: string): boolean {
  let found = false;
  full(method.value.body!, (node) => {
    if (
      node.type === "CallExpression" &&
      memberPath((node as CallExpression).callee) === path
    )
      found = true;
  });
  return found;
}

function literal(method: MethodDefinition, value: string): boolean {
  let found = false;
  full(method.value.body!, (node) => {
    if (node.type === "Literal" && "value" in node && node.value === value)
      found = true;
  });
  return found;
}

export function isHostPatchCandidate(source: string): boolean {
  return (
    source.includes("defaultTurnConfig") ||
    (source.includes("createExtensionRequest") &&
      source.includes("sendToConnection"))
  );
}

/** The hosted manager runs in CommonJS main-process chunks. Its native
 * extension dispatcher delegates flattened starts to sendRequest; prewarming
 * bypasses it. Both paths must share the existing runtime registry. */
export function findHostPatchEdits(source: string): PatchEdit[] {
  const edits: PatchEdit[] = [];
  full(
    parse(source, { ecmaVersion: "latest", sourceType: "module" }),
    (node) => {
      if (node.type !== "ClassBody") return;
      const methods = (node as ClassBody).body.filter(
        (member): member is MethodDefinition =>
          member.type === "MethodDefinition",
      );
      const named = (name: string) =>
        methods.filter(
          (method) =>
            method.key.type === "Identifier" && method.key.name === name,
        );
      const body = (method: MethodDefinition) =>
        source.slice(method.value.body!.start + 1, method.value.body!.end - 1);
      const wrap = (
        method: MethodDefinition,
        point: PatchEdit["point"],
        replacement: string,
      ) => {
        if (!method.value.body || method.static)
          throw new Error(`Unexpected ${point} method shape`);
        edits.push({
          point,
          edits: [
            {
              start: method.value.body.start + 1,
              end: method.value.body.end - 1,
              replacement,
            },
          ],
        });
      };
      const params = (method: MethodDefinition, count: number) => {
        if (
          method.value.params.length !== count ||
          method.value.params.some((param) => param.type !== "Identifier")
        )
          throw new Error("Unexpected hosted request method parameters");
        return (method.value.params as Identifier[]).map((param) => param.name);
      };
      for (const method of named("setDefaultModelConfig")) {
        if (!calls(method, "this.defaultTurnConfig.writeModel")) continue;
        const [model, effort] = params(method, 3);
        wrap(
          method,
          "host-defaults",
          `return ${BINDING}().then(runtime=>runtime.writeDefault(this.requestClient,${model},${effort},async()=>{${body(method)}}));`,
        );
      }
      if (
        !named("createExtensionRequest").length ||
        !named("sendToConnection").length
      )
        return;
      const unique = (name: string) => {
        const matches = named(name);
        if (matches.length !== 1)
          throw new Error(
            `Expected exactly one hosted ${name}; found ${matches.length}`,
          );
        return matches[0]!;
      };
      const request = unique("sendRequest");
      const prewarm = unique("prewarmThreadStart");
      const extension = unique("sendAppServerExtensionRequest");
      if (
        !calls(request, "this.createRequest") ||
        !calls(request, "this.send") ||
        !literal(prewarm, "thread/start") ||
        !calls(prewarm, "this.createRequest") ||
        !calls(extension, "this.sendRequest") ||
        calls(extension, "this.createRequest") ||
        !(
          literal(extension, "turn/addUserMessage") ||
          literal(extension, "thread/start")
        )
      )
        throw new Error("Unexpected hosted dispatcher structure");
      const [method, input, options] = params(request, 3);
      wrap(
        request,
        "host-request",
        `return ${BINDING}().then(runtime=>runtime.intercept(this,${method},${input},${options},async(${method},${input},${options})=>{${body(request)}}));`,
      );
      const [warmInput] = params(prewarm, 2);
      wrap(
        prewarm,
        "host-prewarm",
        `return ${BINDING}().then(runtime=>runtime.prewarm(this,${warmInput},async(${warmInput})=>{${body(prewarm)}}));`,
      );
    },
  );
  return edits;
}
