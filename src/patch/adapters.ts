import compatibility from "./compatibility.json" with { type: "json" };

/**
 * Compatibility is deliberately explicit. A desktop update needs a reviewed
 * adapter and fixture/integration validation, not a best-effort regex guess.
 * These hashes cover just the two upstream assets we modify.
 */
export interface Adapter {
  version: string;
  shared: { path: string; sha256: string };
  picker: { path: string; sha256: string };
}

export const ADAPTERS: readonly Adapter[] = compatibility.adapters;

export const RUNTIME_DIRECTORY = "webview/assets/codex-desktop-providers";
export const RUNTIME_ASSETS = ["index.js", "registry.js", "types.js"] as const;
export const MANIFEST_PATH = "codex-desktop-providers.json";
export const PATCH_VERSION = "0.5.0";
