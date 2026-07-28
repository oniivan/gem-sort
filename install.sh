#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if command -v spicetify >/dev/null 2>&1; then
  spicetify_bin=$(command -v spicetify)
elif [ -n "${HOME:-}" ] && [ -x "$HOME/.spicetify/spicetify" ]; then
  spicetify_bin="$HOME/.spicetify/spicetify"
else
  echo "Spicetify is not installed. See https://spicetify.app/docs/getting-started" >&2
  exit 1
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "The Gem Sort installer currently supports macOS only." >&2
  exit 1
fi

spotify_resources="/Applications/Spotify.app/Contents/Resources"
if [ ! -d "$spotify_resources" ]; then
  echo "Spotify was not found at $spotify_resources" >&2
  exit 1
fi

config_file=$("$spicetify_bin" -c)
extensions_dir=$(dirname "$config_file")/Extensions
extension_target="$extensions_dir/gem-sort.js"
legacy_target="$extensions_dir/stream-rank.js"

mkdir -p "$extensions_dir"
install -m 0644 "$project_dir/gem-sort.js" "$extension_target"

"$spicetify_bin" config spotify_path "$spotify_resources"
"$spicetify_bin" config extensions gem-sort.js
if [ -f "$config_file" ] && grep -Fq "stream-rank.js" "$config_file"; then
  "$spicetify_bin" config extensions stream-rank.js-
fi

if pgrep -x Spotify >/dev/null 2>&1; then
  osascript -e 'tell application "Spotify" to quit'
  while pgrep -x Spotify >/dev/null 2>&1; do
    sleep 1
  done
fi

backup_version=
if [ -f "$config_file" ]; then
  backup_version=$(
    awk '
      /^\[Backup\][[:space:]]*$/ {
        in_backup = 1
        next
      }
      /^\[/ {
        in_backup = 0
      }
      in_backup && /^[[:space:]]*version[[:space:]]*=/ {
        sub(/^[^=]*=[[:space:]]*/, "")
        sub(/[[:space:]]*$/, "")
        print
        exit
      }
    ' "$config_file"
  )
fi

if [ -n "$backup_version" ]; then
  "$spicetify_bin" apply
else
  "$spicetify_bin" backup apply
fi

if [ -f "$legacy_target" ]; then
  rm -f "$legacy_target"
fi

open -a Spotify

echo "Installed Gem Sort at $extension_target"
