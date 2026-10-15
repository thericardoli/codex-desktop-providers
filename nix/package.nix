{
  lib,
  buildNpmPackage,
  nodejs_24,
  stdenvNoCC,
  makeWrapper,
  source ? ../.,
}:

let
  package = builtins.fromJSON (builtins.readFile "${source}/package.json");
  isRelease = builtins.pathExists "${source}/release.json";
  release =
    if isRelease then builtins.fromJSON (builtins.readFile "${source}/release.json") else null;
  compatibility = builtins.fromJSON (
    builtins.readFile (
      if isRelease then
        "${source}/dist/patch/compatibility.json"
      else
        "${source}/src/patch/compatibility.json"
    )
  );
  common = {
    pname = "codex-desktop-providers";
    version = package.version;
    passthru.desktop = compatibility.desktop;
    meta = {
      description = "Version-checked direct-provider model support for Codex Desktop";
      license = lib.licenses.mit;
      mainProgram = "codex-desktop-providers";
      platforms = [ "x86_64-linux" ];
    };
  };
in
if isRelease then
  assert lib.assertMsg (
    release.schemaVersion == 1
    && release.version == package.version
    && release.desktopVersion == compatibility.desktop.version
    && builtins.match "[0-9a-f]{40}" release.sourceRevision != null
  ) "Inconsistent codex-desktop-providers release metadata";
  stdenvNoCC.mkDerivation (
    common
    // {
      src = source;
      nativeBuildInputs = [ makeWrapper ];
      dontBuild = true;
      installPhase = ''
        runHook preInstall
        destination="$out/lib/node_modules/codex-desktop-providers"
        mkdir -p "$destination" "$out/bin"
        cp -R dist node_modules package.json README.md LICENSE "$destination/"
        makeWrapper ${lib.getExe nodejs_24} "$out/bin/codex-desktop-providers" \
          --add-flags "$destination/dist/cli.js"
        runHook postInstall
      '';
      doInstallCheck = true;
      installCheckPhase = ''
        "$out/bin/codex-desktop-providers" --help > /dev/null
      '';
    }
  )
else
  buildNpmPackage (
    common
    // {
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

      npmDepsHash = "sha256-9Zg1f5FTucfsuWJnPJ5tM7N5aDrZ1yidHC56yOwjrIU=";
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
      '';

    }
  )
