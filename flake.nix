{
  description = "Direct model-provider support for Codex Desktop";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      package = pkgs.callPackage ./nix/package.nix { };
    in
    {
      packages.${system} = {
        default = package;
        codex-desktop-providers = package;
      };
      checks.${system} = {
        inherit package;

        upstream = pkgs.callPackage ./nix/check-upstream.nix { inherit package; };
      };
      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.nodejs_24
          pkgs.nixfmt
        ];
      };
    };
}
