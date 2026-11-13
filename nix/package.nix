{
  lib,
  buildNpmPackage,
  nodejs_24,
  source ? ../.,
}:
let
  package = builtins.fromJSON (builtins.readFile "${source}/package.json");
in
buildNpmPackage {
  pname = "codex-desktop-providers";
  version = package.version;
  nodejs = nodejs_24;

  src = lib.cleanSourceWith {
    src = source;
    filter =
      path: type:
      !(lib.elem (baseNameOf path) [
        ".git"
        "node_modules"
        "dist"
        ".test-dist"
        "result"
        "release"
        "release-test"
        "release-result"
      ]);
  };

  npmDepsHash = "sha256-LnEe02+fF8Na7ehAx+1XuWzdAm9i8cIgrOhePz/KiGY=";
  npmBuildScript = "build";
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm run check:versions
    npm run typecheck
    npm test
    npm run format:check
    runHook postCheck
  '';
  postInstall = ''
    node "$out/lib/node_modules/codex-desktop-providers/dist/cli.js" --help > /dev/null
    test -f "$out/lib/node_modules/codex-desktop-providers/examples/external-models.json"
  '';
  meta = {
    description = "Structure-based direct-provider model support for Codex Desktop";
    license = lib.licenses.mit;
    mainProgram = "codex-desktop-providers";
    platforms = [ "x86_64-linux" ];
  };
}
