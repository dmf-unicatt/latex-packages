#!/usr/bin/env python3
import os
import subprocess
import sys

def main() -> None:
    """
    Run GitHub Actions locally using act, optionally passing matrix tags.

    Usage
    -----
    python run_act.py [container_name_1 container_name_2 ...]
    """
    # Go back to parent directory
    os.chdir("..")

    # Common args
    args = ["act", "--rm", "-W", ".github/workflows/ci.yml", "-j", "test-packages-in-docker"]

    # Append matrix arg for each argument
    for arg in sys.argv[1:]:
        tag_name = arg.replace(":", "-")
        args.extend(["--matrix", f"tag-name:{tag_name}"])

    # Run act
    result = subprocess.run(args)
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
