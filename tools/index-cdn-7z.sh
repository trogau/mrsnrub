#!/usr/bin/env bash
#
# index-cdn-7z.sh — index every .7z archive under ./cdn into one text file.
#
# Output: <project-root>/cdn-index.txt (one file per line)
#   Each line looks like:
#     cdn/3_0_0.7z  ::  cdn/3_0_0.7z/assets/foo/bar.png
#   i.e. the containing archive, a " :: " separator, then the full path of
#   the archived file (archive path + its path inside the archive).
#
# Usage:  tools/index-cdn-7z.sh [output-file]
#
set -euo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CDN="$BASE/cdn"
OUT="${1:-$BASE/cdn-index.txt}"
SEP=' :: '

command -v 7z >/dev/null 2>&1 || { echo "error: 7z not found in PATH" >&2; exit 1; }
[ -d "$CDN" ] || { echo "error: $CDN does not exist" >&2; exit 1; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

count=0
# NUL-delimited find so weird filenames are safe; sort for stable output.
while IFS= read -r -d '' archive; do
    rel="${archive#"$BASE"/}"          # show paths relative to the project root
    # `7z l -slt` prints key = value blocks after a ---------- separator;
    # keep Path= lines that are not directories (Attributes = D).
    7z l -slt -- "$archive" 2>/dev/null |
        awk -v arc="$rel" -v sep="$SEP" '
            /^----------/ { listing = 1; next }
            listing && /^Path = / {
                if (path != "" && !isdir) print arc sep arc "/" path
                path = substr($0, 8); isdir = 0; next
            }
            listing && /^Attributes = / { if ($0 ~ /(^| )D( |$)/) isdir = 1; next }
            END { if (path != "" && !isdir) print arc sep arc "/" path }
        ' >> "$tmp"
    count=$((count + 1))
    printf 'indexed %d: %s\n' "$count" "$rel" >&2
done < <(find "$CDN" -type f -name '*.7z' -print0 | sort -z)

sort "$tmp" > "$OUT"

echo "wrote $(wc -l < "$OUT") entries from $count archives to $OUT" >&2
