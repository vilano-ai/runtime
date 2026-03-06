{
  description = "Vilano Runtime development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system:
          f (import nixpkgs { inherit system; }));
    in
    {
      devShells = forAllSystems (pkgs:
        let
          beamPackages = pkgs.beam.packages.erlang_28;
        in
        {
          default = pkgs.mkShell {
            packages =
              [
                pkgs.bun
                beamPackages.erlang
                beamPackages.elixir_1_18
                beamPackages.hex
                beamPackages.rebar3
                pkgs.sqlite
                pkgs.pkg-config
                pkgs.gnumake
                pkgs.git
                pkgs.jq
              ]
              ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
                pkgs.gcc
              ]
              ++ pkgs.lib.optionals pkgs.stdenv.isDarwin [
                pkgs.llvmPackages.clang
                pkgs.libiconv
              ];

            shellHook = ''
              export MIX_ENV=dev
              export MIX_HOME="$PWD/.mix"
              export HEX_HOME="$PWD/.hex"
              export PATH="$PWD/node_modules/.bin:$PATH"
            '';
          };
        });
    };
}
