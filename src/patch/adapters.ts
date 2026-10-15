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

export const ADAPTERS: readonly Adapter[] = [
  {
    version: "26.1007.71326",
    shared: {
      path: "webview/assets/app-shared-6fc3d63f0486.js",
      sha256:
        "e24dc1a9e516fb12b36edfe2ae984185ca1238787fcc19938501a097b1acd06c",
    },
    picker: {
      path: "webview/assets/app-initial-17317d71fd80.js",
      sha256:
        "3cec672b3ffa028c5e7d47eab4198ef0102bd04955e45282154de8aa3f840ce1",
    },
  },
];

export const RUNTIME_DIRECTORY = "webview/assets/codex-desktop-providers";
export const RUNTIME_ASSETS = ["index.js", "registry.js", "types.js"] as const;
export const MANIFEST_PATH = "codex-desktop-providers.json";
export const PATCH_VERSION = "0.1.0";
