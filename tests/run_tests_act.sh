#!/bin/bash
# Go back to root directory
cd ..

# Common args
ARGS=(--rm -W .github/workflows/ci.yml -j test-packages-in-docker)

# Append matrix arg only if container name is given
for ARG in "$@"; do
    TAG_NAME="${ARG//:/-}"
    ARGS+=(--matrix "tag-name:$TAG_NAME")
done

# Run act
act "${ARGS[@]}"
