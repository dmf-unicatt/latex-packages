#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile

def main() -> None:
    """
    Run GitHub Actions locally using act, optionally passing matrix tags.

    Usage
    -----
    python run_act_build.py [container_name_1 container_name_2 ...]
    """
    # Go back to parent directory
    os.chdir("..")

    # Common args
    args = ["act", "workflow_dispatch", "--rm", "-W", ".github/workflows/docker.yml", "-j", "build"]

    # Attach workflow dispatch inputs in a temporary event file
    event = {"inputs": {"publish": "false"}}
    with tempfile.NamedTemporaryFile("w", delete=False) as f:
        json.dump(event, f)
        f.flush()
        event_file = f.name
    args.extend(["-e", event_file])

    # Append matrix arg for each argument
    for arg in sys.argv[1:]:
        tag_name = arg.replace(":", "-")
        args.extend(["--matrix", f"tag-name:{tag_name}"])

    # Run act
    result = subprocess.run(args)

    # Clean up temporary event file
    os.remove(event_file)

    # Exit with same status code as act
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
