#!/bin/bash
if [ "$#" -ne 0 ]; then
  echo "This script does not accept any arguments." >&2
  exit 1
fi

cd ..
act --rm -W .github/workflows/ci.yml -j test-packages-in-docker
