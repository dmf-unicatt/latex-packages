#!/usr/bin/env bash
# This script opens the markdown.sty file, and searches for snippets with
# \renewenvironment{markdown}{...}
# and then *duplicates* the snippet to a
# - \newenvironment (instead of \renewenvironment)
# - mdcell environment name (in addition to markdown)
# The patch is only applied on old LaTeX versions, pre 2025.06

set -euo pipefail

FILE="$1"
BACKUP="$FILE.bak"

if [[ ! -f "$FILE" ]]; then
    echo "File $FILE not found"
    exit 1
fi

# Extract texlive-base version number (YYYY.MMDDNN)
TLVER_FULL=$(dpkg -s texlive-base 2>/dev/null | grep '^Version:' | awk '{print $2}')
TLVER=${TLVER_FULL%%-*}  # remove trailing -1
MINVER="2024.20250309"

# Compare numerically
if (( 10#${TLVER/./} >= 10#${MINVER/./} )); then
    echo "texlive-base version $TLVER_FULL >= $MINVER, skipping patch"
    exit 0
fi

# Apply patch
cp "$FILE" "$BACKUP"

awk -v fname="$FILE" '
BEGIN { in_env=0; found=0; env_lines="" }
/\\renewenvironment/ {
    in_env=1
    env_lines = $0 "\n"
    next
}
in_env {
    env_lines = env_lines $0 "\n"
    # check for \markdownEnd ignoring spaces and optional %
    if ($0 ~ /\\markdownEnd[[:space:]]*%*/) {
        in_env=0
        found=1
        # print original
        printf "%s", env_lines
        # create copy
        env_copy = env_lines
        gsub(/\\renewenvironment/, "\\newenvironment", env_copy)
        gsub(/\{[[:space:]]*markdown[[:space:]]*\}/, "{ mdcell }", env_copy)
        printf "%s\n", env_copy
        env_lines=""
    }
    next
}
{ print }
END {
    if (found==0) {
        print "Error: markdown environment not found" > "/dev/stderr"
        system("cat " fname)
        exit 1
    }
}
' "$BACKUP" > "$FILE"
echo "Applied patch to $FILE"
