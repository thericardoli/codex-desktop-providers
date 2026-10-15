{
  lib,
  buildNpmPackage,
  nodejs_24,
  source ? ../.,
}:

buildNpmPackage {
  pname = "codex-desktop-providers";
  version = "0.1.0";
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
      ]);
  };

  npmDepsHash = "sha256-5aIWCk4yg+uQDjYcI0j5A1jyjXIHafIEy0heEwRpNwA=";
  npmBuildScript = "build";

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm test
    runHook postCheck
  '';

  meta = {
    description = "Version-checked direct-provider model support for Codex Desktop";
    license = lib.licenses.mit;
    mainProgram = "codex-desktop-providers";
    platforms = lib.platforms.linux;
  };
}
