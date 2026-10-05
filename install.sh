#!/bin/sh
# Installs the fshare CLI from GitHub:
#   curl -fsSL https://raw.githubusercontent.com/akdevv/fshare/main/install.sh | sh
# It clones the repo into ~/.fshare, builds the CLI there, and links `fshare` into your PATH.
# Run it again (or `fshare update`) to update; `fshare uninstall` removes it.
# Settings: FSHARE_HOME (install folder), FSHARE_BIN (where the `fshare` link goes),
# FSHARE_REPO and FSHARE_REF (what to install; for testing).
set -eu

repo="${FSHARE_REPO:-https://github.com/akdevv/fshare.git}"
ref="${FSHARE_REF:-main}"
home_dir="${FSHARE_HOME:-$HOME/.fshare}"

say() { printf '  %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "fshare needs git. Install it, then run this again."
command -v node >/dev/null 2>&1 || fail "fshare needs Node.js 20.12 or newer: https://nodejs.org"
command -v npm >/dev/null 2>&1 || fail "fshare needs npm (it comes with Node.js)."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=12)?0:1)' ||
  fail "fshare needs Node.js 20.12 or newer (you have $(node -v)): https://nodejs.org"

if [ -d "$home_dir/.git" ]; then
  say "Updating fshare in $home_dir…"
  git -C "$home_dir" fetch --quiet --depth 1 origin "$ref"
  git -C "$home_dir" checkout --quiet --force FETCH_HEAD
else
  [ -e "$home_dir" ] && fail "$home_dir exists but isn't an fshare install. Move it, or set FSHARE_HOME."
  say "Downloading fshare…"
  git clone --quiet --depth 1 --branch "$ref" "$repo" "$home_dir"
fi

say "Building…"
# `prepare` compiles the CLI as part of the install
(cd "$home_dir/cli" && npm ci --no-audit --no-fund --loglevel=error >/dev/null) || fail "Building fshare failed (see above)."
chmod +x "$home_dir/cli/dist/fshare.js"

# /usr/local/bin when it's writable (no sudo), else ~/.local/bin
bin="${FSHARE_BIN:-}"
if [ -z "$bin" ]; then
  if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then bin=/usr/local/bin; else bin="$HOME/.local/bin"; fi
fi
mkdir -p "$bin"
ln -sf "$home_dir/cli/dist/fshare.js" "$bin/fshare"

version=$(node -p "require('$home_dir/cli/package.json').version")
printf '\n  \033[1;92m✓\033[0m fshare v%s is installed\n\n' "$version"
case ":$PATH:" in
  *":$bin:"*) say "Run it:  fshare" ;;
  *)
    profile="$HOME/.profile"
    case "${SHELL:-}" in */zsh) profile="$HOME/.zshrc" ;; */bash) profile="$HOME/.bashrc" ;; esac
    say "Add fshare to your PATH, then open a new terminal:"
    say "  echo 'export PATH=\"$bin:\$PATH\"' >> $profile"
    say "Then run:  fshare"
    ;;
esac
