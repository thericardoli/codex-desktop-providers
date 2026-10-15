{
  lib,
  buildNpmPackage,
  nodejs_24,
  source ? ../.,
}:

buildNpmPackage {
  pname = "codex-desktop-providers";
  version = "0.2.0";
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

  npmDepsHash = "sha256-sBABbF38tUU3A5uyOR/HiaJE8Ooz7snfF8A7nEs8mvg=";
  npmBuildScript = "build";

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm test
    runHook postCheck
  '';

  postInstall = ''
    node "$out/lib/node_modules/codex-desktop-providers/dist/cli.js" --help > /dev/null
  '';

  meta = {
    description = "Version-checked direct-provider model support for Codex Desktop";
    license = lib.licenses.mit;
    mainProgram = "codex-desktop-providers";
    platforms = lib.platforms.linux;
  };
}
