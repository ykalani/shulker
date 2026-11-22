#!/bin/sh
# shulker installer
#
#   curl -fsSL https://raw.githubusercontent.com/ykalani/shulker/main/install.sh | sh
#
# Options (pass after `sh -s --`):
#   --version <x.y.z>   install a specific release instead of the latest
#   --uninstall         remove shulker
#
# Environment:
#   SHULKER_HOME     where the app lives        (default: ~/.shulker)
#   SHULKER_BIN      where the command is linked (default: ~/.local/bin)
#   SHULKER_REPO     GitHub repo to install from (default: ykalani/shulker)
#   SHULKER_TARBALL  install from this local .tgz or URL instead of a release
#
# Nothing here needs sudo. Everything installs into your home folder.

set -eu

REPO="${SHULKER_REPO:-ykalani/shulker}"
APP_HOME="${SHULKER_HOME:-$HOME/.shulker}"
BIN_DIR="${SHULKER_BIN:-$HOME/.local/bin}"
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=11

if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"; RED="$(printf '\033[31m')"
  GREEN="$(printf '\033[32m')"; YELLOW="$(printf '\033[33m')"; RESET="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

say() { printf '%s\n' "$*"; }
step() { printf '%s›%s %s\n' "$DIM" "$RESET" "$*"; }
warn() { printf '%swarning:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
fail() { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

uninstall() {
  step "removing $APP_HOME"
  rm -rf "$APP_HOME"
  if [ -L "$BIN_DIR/shulker" ]; then
    step "removing $BIN_DIR/shulker"
    rm -f "$BIN_DIR/shulker"
  fi
  say "${GREEN}shulker is uninstalled.${RESET}"
}

check_platform() {
  case "$(uname -s)" in
    Darwin) OS="macos" ;;
    Linux) OS="linux" ;;
    *) fail "shulker runs on macOS and Linux." ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64 | arm64 | aarch64) ;;
    *) fail "shulker needs a 64-bit Intel/AMD or ARM computer; this one is $(uname -m)." ;;
  esac
  if [ "$OS" = "linux" ]; then
    # The graphics runtime is downloaded as a zip.
    command -v unzip >/dev/null 2>&1 || fail "shulker needs unzip. Install it with your package manager, e.g.
       sudo apt install unzip   or   sudo dnf install unzip   or   sudo pacman -S unzip"
  fi
}

node_hint() {
  if [ "$OS" = "macos" ]; then
    printf '%s' "brew install node   (or from https://nodejs.org)"
  else
    printf '%s' "your package manager (e.g. sudo apt install nodejs npm), or from https://nodejs.org"
  fi
}

check_node() {
  command -v node >/dev/null 2>&1 || fail "shulker needs Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer.
       Install it with:  $(node_hint)"
  command -v npm >/dev/null 2>&1 || fail "npm was not found. It normally comes with Node.js; on some Linux systems it is a separate package."
  version="$(node -p 'process.versions.node')"
  major="$(printf '%s' "$version" | cut -d. -f1)"
  minor="$(printf '%s' "$version" | cut -d. -f2)"
  if [ "$major" -lt "$MIN_NODE_MAJOR" ] || { [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -lt "$MIN_NODE_MINOR" ]; }; then
    fail "shulker needs Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer; you have $version.
       Update it with:  $(node_hint)"
  fi
}

# sha256 of a file: shasum on macOS, sha256sum on Linux (where shasum may be missing).
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# The newest release's version. Resolved once, so the package and its
# checksum come from the same release even if a new one is published meanwhile.
latest_version() {
  url="$(curl -fsSLI --retry 3 -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" ||
    fail "could not reach https://github.com/$REPO/releases/latest"
  tag="${url##*/}"
  case "$tag" in
    v[0-9]*) printf '%s' "${tag#v}" ;;
    *) fail "no release found at https://github.com/$REPO/releases (latest resolved to $url)" ;;
  esac
}

tarball_url() {
  if [ -n "${SHULKER_TARBALL:-}" ]; then
    printf '%s' "$SHULKER_TARBALL"
  else
    printf 'https://github.com/%s/releases/download/v%s/shulker.tgz' "$REPO" "${VERSION#v}"
  fi
}

# Checks a download against the .sha256 file published next to it. Releases
# always publish one, so for them a missing checksum is an error; a custom
# SHULKER_TARBALL URL is checked only when it has one.
verify() {
  file="$1"
  url="$2"
  if ! curl -fsL --retry 3 -o "$file.sha256" "$url.sha256"; then
    [ -n "${SHULKER_TARBALL:-}" ] || fail "could not download the checksum $url.sha256"
    warn "no checksum at $url.sha256; installing unverified"
    return 0
  fi
  expected="$(cut -d' ' -f1 <"$file.sha256")"
  actual="$(sha256 "$file")"
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $url
       expected $expected
       got      $actual"
  step "checksum verified"
}

install() {
  check_platform
  check_node

  if [ -z "$VERSION" ] && [ -z "${SHULKER_TARBALL:-}" ]; then
    VERSION="$(latest_version)"
  fi
  source="$(tarball_url)"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT INT TERM

  case "$source" in
    http://* | https://*)
      step "downloading ${source}"
      curl -fsSL --retry 3 -o "$tmp/shulker.tgz" "$source" ||
        fail "could not download $source
       Check the version exists at https://github.com/$REPO/releases"
      verify "$tmp/shulker.tgz" "$source"
      ;;
    *)
      [ -f "$source" ] || fail "no such file: $source"
      cp "$source" "$tmp/shulker.tgz"
      ;;
  esac

  # Install next to the old copy and swap at the end, so a failed install leaves the old one working.
  step "installing into $APP_HOME ${DIM}(this also fetches the graphics runtime, about 100 MB)${RESET}"
  staging="$APP_HOME.new"
  rm -rf "$staging"
  mkdir -p "$staging"
  # npm 12 skips dependency install scripts unless allowScripts names them, and
  # pixel's postinstall is what fetches the graphics runtime.
  printf '{ "name": "shulker-install", "private": true }\n' >"$staging/package.json"
  # The graphics runtime unpacks in the temp folder and then moves into place,
  # which fails when /tmp is on another filesystem (tmpfs on most Linux
  # systems). A temp folder next to the install keeps it on the same one.
  mkdir -p "$staging/.tmp"
  if ! (cd "$staging" && TMPDIR="$staging/.tmp" npm install --omit=dev --no-fund --no-audit --loglevel=error "$tmp/shulker.tgz" >"$tmp/npm.log" 2>&1); then
    cat "$tmp/npm.log" >&2
    rm -rf "$staging"
    fail "npm install failed (log above)."
  fi
  rm -rf "$staging/.tmp"
  rm -rf "$APP_HOME"
  mv "$staging" "$APP_HOME"

  mkdir -p "$BIN_DIR"
  ln -sf "$APP_HOME/node_modules/.bin/shulker" "$BIN_DIR/shulker"
  installed="$(node -p "require('$APP_HOME/node_modules/shulker/package.json').version")"

  say ""
  say "${GREEN}${BOLD}shulker ${installed} is installed.${RESET}"
  case ":$PATH:" in
    *":$BIN_DIR:"*)
      say "Run ${BOLD}shulker${RESET} to see what is filling your disk."
      ;;
    *)
      say ""
      warn "$BIN_DIR is not on your PATH. Add it with:"
      say ""
      case "${SHELL:-}" in
        */fish)
          say "  fish_add_path $BIN_DIR"
          ;;
        *)
          if [ "$OS" = "macos" ]; then shell_rc="$HOME/.zshrc"; else shell_rc="$HOME/.profile"; fi
          case "${SHELL:-}" in
            */bash) if [ "$OS" = "macos" ]; then shell_rc="$HOME/.bash_profile"; else shell_rc="$HOME/.bashrc"; fi ;;
            */zsh) shell_rc="$HOME/.zshrc" ;;
          esac
          say "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> $shell_rc && . $shell_rc"
          ;;
      esac
      say ""
      say "Then run ${BOLD}shulker${RESET}."
      ;;
  esac
  say "${DIM}Tip: shulker --dry-run lets you try everything without deleting anything.${RESET}"
}

VERSION=""
ACTION="install"
while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || fail "--version needs a value"; VERSION="$2"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    -h | --help) sed -n '2,17p' "$0" 2>/dev/null || true; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

# Everything above only defines things; this last line runs them, so a
# half-downloaded script does nothing.
if [ "$ACTION" = "uninstall" ]; then uninstall; else install; fi
