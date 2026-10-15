# Download upstream only for build-time CI validation; never include it in releases.
{
  runCommand,
  fetchurl,
  dpkg,
  nodejs_24,
  package,
}:
let
  desktop = package.desktop;
  upstream = fetchurl { inherit (desktop) url hash; };
in
runCommand "codex-desktop-providers-upstream-${desktop.version}"
  {
    nativeBuildInputs = [
      dpkg
      nodejs_24
    ];
  }
  ''
    dpkg-deb -x ${upstream} upstream
    archive="$PWD/upstream/usr/lib/chatgpt/resources/app.asar"
    ${package}/bin/codex-desktop-providers check --asar "$archive"
    ${package}/bin/codex-desktop-providers patch --asar "$archive"
    ${package}/bin/codex-desktop-providers check --asar "$archive" > manifest.json
    grep -q '"status": "already-patched"' manifest.json

    mkdir scripts
    cp ${../scripts/verify-upstream.mjs} scripts/verify-upstream.mjs
    cp -R ${package}/lib/node_modules/codex-desktop-providers/{dist,node_modules} .
    node scripts/verify-upstream.mjs --asar "$archive"
    mkdir "$out"
    cp manifest.json "$out/manifest.json"
  ''
