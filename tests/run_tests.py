#!/usr/bin/env python3
from __future__ import annotations

import copy
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile

# Configuration: colors
def use_color() -> bool:
    """
    Determine if it is safe to enable colored output in the current environment.

    This function enables color only if all the following are true:
    - The output stream (stdout) is connected to a terminal (TTY), so ANSI codes will be interpreted correctly.
    - The environment is not a CI environment that disables color, with special handling for GitHub Actions:
        - Color is disabled on real GitHub Actions runners.
        - Color is enabled on Nektos Act (local GitHub Actions runner) if the environment variable ACT="true".

    Returns
    -------
    bool
        True if colored output can safely be used (i.e., stdout is a TTY and
        either not running on GitHub Actions or running on Nektos Act).
        False otherwise.
    """
    # Disable color if stdout is not a terminal (e.g., redirected to a file)
    if not sys.stdout.isatty():
        return False

    # Special handling for GitHub Actions environment
    if os.getenv("GITHUB_ACTIONS"):
        # Enable color when running Nektos Act
        if os.getenv("ACT") == "true":
            return True
        else:
            # Disable color on real GitHub Actions runners
            return False

    # Default to enabling color in all other environments
    return True

USE_COLOR = use_color()

# Configuration: python
PYTHON_CMD = [sys.executable]

# Configuration: latex
LATEXMK_CMD = ["latexmk", "-interaction=nonstopmode"]
PDFTOTEXT_CMD = ["pdftotext", "-layout"]
CLEAN_CMD = ["latexmk", "-C"]

# Configuration: diff
DIFF_CMD = ["diff", "-u", "-w", "--color=always" if USE_COLOR else "--color=never"]
NBDIFF_CMD = [
    "nbdiff", "--color-words" if USE_COLOR else "--no-color", "--ignore-outputs", "--ignore-metadata", "--ignore-id"]

# Configuration: pytest-like FAIL, XFAIL and PASS
if USE_COLOR:
    RED = "\033[1;31m"
    YELLOW = "\033[1;33m"
    GREEN = "\033[1;32m"
    BOLD_BLACK = "\033[1;30m"
    RESET = "\033[0m"
else:
    RED = YELLOW = GREEN = RESET = BOLD_BLACK = ""

FAIL = f"{RED}FAIL{RESET}"
XFAIL = f"{YELLOW}XFAIL{RESET}"
REGOLDED = f"{YELLOW}REGOLDED{RESET}"
PASS = f"{GREEN}PASS{RESET}"
SUMMARY = f"{BOLD_BLACK}Test summary{RESET}"


def run_command(command: list[str], cwd: str) -> tuple[int, str, str]:
    """
    Run a command as a subprocess in a given working directory.

    Parameters
    ----------
    command
        The command and arguments to run.
    cwd
        Working directory to run the command in.

    Returns
    -------
    A tuple of (return_code, stdout, stderr).
    """
    result = subprocess.run(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return result.returncode, result.stdout.decode(), result.stderr.decode()


def check_ordered_subsequence_with_missing(expected_lines: list[str], actual_lines: list[str]) -> bool:
    """
    Check if expected_lines appear in actual_lines in order.

    Returns
    -------
    A boolean to indicate success or not.
    """
    expected_lines = [normalize_text(line)[0] for line in expected_lines if line.strip()]
    actual_lines = [normalize_text(line)[0] for line in actual_lines if line.strip()]

    expected_idx = 0
    missing = []
    for line in actual_lines:
        if expected_idx >= len(expected_lines):
            break
        if expected_lines[expected_idx] in line:
            expected_idx += 1
    return (expected_idx == len(expected_lines))


def merge_lines_with_continuation(lines: list[str]) -> list[str]:
    """
    Merge consecutive lines that end with the continuation character ~.

    Parameters
    ----------
    lines
        The input lines. Lines ending with ~ indicate that the next line
        should be concatenated to the current one.

    Returns
    -------
    merged_lines
        The resulting lines after merging continuation lines. The ~
        characters are removed in the merged output.
    """
    merged_lines = []
    buffer = ""
    for line in lines:
        line = line.rstrip()  # remove trailing spaces
        if line.endswith("~"):
            buffer += line[:-1]  # append without the '~'
        else:
            if buffer:
                buffer += line
                merged_lines.append(buffer)
                buffer = ""
            else:
                merged_lines.append(line)
    if buffer:
        merged_lines.append(buffer)
    return merged_lines


def normalize_text(text: str) -> list[str]:
    """
    Normalize a block of text for whitespace-insensitive comparisons.

    This function:
      - Splits the text into lines.
      - Removes **all** whitespace characters (spaces, tabs, etc.) from each line.
      - Discards any lines that become empty after whitespace removal.

    Parameters
    ----------
    text
        The input text block.

    Returns
    -------
    :
        List of normalized lines with all whitespace removed and empty lines discarded.
    """
    return ["".join(line.split()) for line in text.splitlines() if line.strip()]


def normalize_notebook(nb: dict[str, any]) -> dict[str, any]:
    """
    Normalize a Jupyter notebook dictionary for robust comparison.

    This function removes fields that are commonly non-deterministic
    or irrelevant for testing content equality, such as execution counts,
    cell IDs, and metadata. This allows two notebooks to be compared
    based on their actual content (e.g. source code and outputs),
    ignoring differences that arise from execution order or environment.

    Parameters
    ----------
    nb
        A notebook parsed from a .ipynb file using `json.load()`.

    Returns
    -------
    dict
        A new notebook dictionary with irrelevant fields normalized:
        - Top-level "metadata"
        - Per-cell "metadata", "id", and "execution_count"
        - Per-output "metadata" and "execution_count"
    """
    nb = copy.deepcopy(nb)
    if "metadata" in nb:
        nb["metadata"] = {}

    for cell in nb.get("cells", []):
        if "execution_count" in cell:
            cell["execution_count"] = None
        if "metadata" in cell:
            cell["metadata"] = {}

        if "outputs" in cell:
            for output in cell["outputs"]:
                if "execution_count" in output:
                    output["execution_count"] = None
                if "metadata" in output:
                    output["metadata"] = {}

    return nb


def notebook_has_code_cells(nb: dict[str, any]) -> bool:
    """
    Determine whether a Jupyter notebook contains at least one code cell.

    This function inspects the notebook's cell list and checks if any
    cell is of type "code". A notebook parsed from a .ipynb file using
    `json.load()` has a top-level key "cells" which is a list of cell
    dictionaries, each with a "cell_type" field.

    Parameters
    ----------
    nb
        A notebook parsed from a .ipynb file using `json.load()`.

    Returns
    -------
    bool
        True if the notebook contains at least one code cell,
        False otherwise.
    """
    return any(cell.get("cell_type") == "code" for cell in nb.get("cells", []))



def remove_hidden_files_and_directories(directory: str) -> None:
    """
    Recursively delete all hidden files and directories (starting with '.') in a directory.

    Parameters
    ----------
    directory
        Root directory to clean.
    """
    for root, dirs, files in os.walk(directory, topdown=True):
        # Remove hidden directories
        hidden_dirs = [d for d in dirs if d.startswith(".")]
        for d in hidden_dirs:
            full_path = os.path.join(root, d)
            shutil.rmtree(full_path)
        # Avoid descending into them
        dirs[:] = [d for d in dirs if not d.startswith(".")]

        # Remove hidden files
        for filename in files:
            if filename.startswith("."):
                full_path = os.path.join(root, filename)
                os.remove(full_path)

class FailureCounter:
    """
    Counter for tracking the number of test failures, with a maximum limit.

    Attributes
    ----------
    count
        Current failure count.
    maxfail
        Maximum allowed failures before exiting the program.
    """
    def __init__(self, maxfail: int) -> None:
        """
        Initialize a FailureCounter.

        Parameters
        ----------
        maxfail
            Maximum allowed failures before exiting (default is infinity).
        """
        self.count = 0
        self.maxfail = maxfail

    def __iadd__(self, n: int) -> FailureCounter:
        """
        Increment the counter by a given number.

        Parameters
        ----------
        n
            Number of failures to add.

        Returns
        -------
        :
            The updated FailureCounter instance.

        Notes
        -----
        This method exits the program with status 1 if `count` exceeds `maxfail`.
        """
        self.count += n
        if self.count >= self.maxfail:
            print(f"Maximum number of failures ({self.maxfail}) reached, stopping.")
            sys.exit(1)
        return self

    def __eq__(self, other: int | FailureCounter) -> bool:
        """
        Check equality with an integer or another FailureCounter.

        Parameters
        ----------
        other
            Value to compare against.

        Returns
        -------
        :
            True if counts are equal, False otherwise.
        """
        if isinstance(other, FailureCounter):
            return self.count == other.count
        return self.count == other

    def __lt__(self, other: int | FailureCounter) -> bool:
        """
        Less-than comparison with an integer or another FailureCounter.

        Parameters
        ----------
        other
            Value to compare against.

        Returns
        -------
        :
            True if self.count is less than `other`, False otherwise.
        """
        if isinstance(other, FailureCounter):
            return self.count < other.count
        return self.count < other

    def __le__(self, other: int | FailureCounter) -> bool:
        """
        Less-than-or-equal comparison with an integer or another FailureCounter.

        Parameters
        ----------
        other
            Value to compare against.

        Returns
        -------
        :
            True if self.count is less than or equal to `other`, False otherwise.
        """
        if isinstance(other, FailureCounter):
            return self.count <= other.count
        return self.count <= other

    def __gt__(self, other: int | FailureCounter) -> bool:
        """
        Greater-than comparison with an integer or another FailureCounter.

        Parameters
        ----------
        other
            Value to compare against.

        Returns
        -------
        :
            True if self.count is greater than `other`, False otherwise.
        """
        if isinstance(other, FailureCounter):
            return self.count > other.count
        return self.count > other

    def __ge__(self, other: int | FailureCounter) -> bool:
        """
        Greater-than-or-equal comparison with an integer or another FailureCounter.

        Parameters
        ----------
        other
            Value to compare against.

        Returns
        -------
        :
            True if self.count is greater than or equal to `other`, False otherwise.
        """
        if isinstance(other, FailureCounter):
            return self.count >= other.count
        return self.count >= other

    def __int__(self) -> int:
        """
        Get integer representation of the failure count.

        Returns
        -------
        :
            Current failure count.
        """
        return self.count

    def __str__(self) -> str:
        """
        Get string representation of the failure count.

        Returns
        -------
        :
            Current failure count as a string.
        """
        return str(self.count)

    def __repr__(self) -> str:
        """
        Get representation of the failure count.

        Returns
        -------
        :
            Current failure count as a string.
        """
        return str(self.count)


def run_latex_tests(tex_tests: list[str], maxfail: int, regold: bool) -> None:
    """
    Run LaTeX tests on given .tex files.

    Parameters
    ----------
    tex_tests
        List of paths to LaTeX test files.
    maxfail
        Maximum number of failing tests allowed before stopping.
    regold
        If True, automatically overwrite files in the expected directory with new outputs.

    Exits
    -----
    Exits with code 1 on failure.
    """
    failure_counter = FailureCounter(maxfail)
    for tex_file in tex_tests:
        test_dir = os.path.dirname(tex_file)
        os.makedirs(os.path.join(test_dir, "expected"), exist_ok=True)

        tex_file = os.path.basename(tex_file)
        base = tex_file[:-4]
        pdf_file = base + ".pdf"
        out_txt = base + ".pdf.txt"

        is_fail_test = base.endswith("FAIL")

        print("Running", os.path.join(test_dir, tex_file), end=" ", flush=True)

        # Determine any required file
        requires = []
        if os.path.exists(os.path.join(test_dir, base + ".requires")):
            with open(os.path.join(test_dir, base + ".requires"), "r", encoding="utf-8") as f:
                for line in f:
                    require_tex_relative = line.strip()
                    if not require_tex_relative:
                        continue
                    dirname = os.path.dirname(require_tex_relative)
                    dirname = os.path.join(test_dir, dirname) if dirname else test_dir
                    basename = os.path.basename(require_tex_relative)
                    requires.append((dirname, basename))

        # Clean up
        run_command(CLEAN_CMD + [tex_file], cwd=test_dir)
        for require in requires:
            run_command(CLEAN_CMD + [require[1]], cwd=require[0])

        # Compile with latexmk any required file
        for require in requires:
            ret, out, err = run_command(LATEXMK_CMD + [require[1]], cwd=require[0])
            if ret != 0:
                print(f"{FAIL} - LaTeX compile error when building requirement {require}")
                print(out + err)
                failure_counter += 1
                continue

        # Compile with latexmk the current tex file
        ret, out, err = run_command(LATEXMK_CMD + [tex_file], cwd=test_dir)

        if is_fail_test:
            # For expected fail tests, compilation should fail or PDF not generated
            if ret == 0:
                print(f"{FAIL} - Expected failure but compilation succeeded")
                failure_counter += 1
                continue

            # Compare with expected error
            expected_err_txt = os.path.join("expected", base + ".err.txt")
            if os.path.exists(os.path.join(test_dir, expected_err_txt)):
                with open(os.path.join(test_dir, expected_err_txt), "r", encoding="utf-8") as exp_f:
                    expected_lines = [line.strip() for line in exp_f if line.strip()]
                    actual_lines = [*out.splitlines(), *err.splitlines()]
                    actual_lines = merge_lines_with_continuation(actual_lines)
                    if check_ordered_subsequence_with_missing(expected_lines, actual_lines):
                        print(f"{XFAIL}")
                    else:
                        with tempfile.NamedTemporaryFile("w", encoding="utf-8") as tmpf:
                            tmpf.write("\n".join(actual_lines))
                            tmpf.flush()
                            print(f"{FAIL} - Expected error lines not found (ignoring whitespaces, entire log):")
                            _, out, err = run_command(
                                DIFF_CMD + [expected_err_txt, tmpf.name]
                                + ["-L", os.path.join(test_dir, expected_err_txt), "-L", "full log"],
                                cwd=test_dir)
                            print(out + err)
                            print("Do not add the entire log, only add a few relevant lines")
                            failure_counter += 1
                            continue
            else:
                print(f"{FAIL} - No expected output {os.path.join(test_dir, expected_err_txt)} . ")
                print(f"Suggestion: search ! in the log file {os.path.join(test_dir, base + '.log')} .")
                failure_counter += 1
                continue
        else:
            # Normal tests: expect success
            if ret != 0:
                print(f"{FAIL} - LaTeX compile error")
                print(out + err)
                failure_counter += 1
                continue

            # Ensure that PDF file was generated
            if not os.path.exists(os.path.join(test_dir, pdf_file)):
                print(f"{FAIL} - PDF not generated")
                failure_counter += 1
                continue

            # Convert PDF to text
            ret, out, err = run_command(PDFTOTEXT_CMD + [pdf_file, out_txt], cwd=test_dir)
            if ret != 0:
                print(f"{FAIL} - pdftotext failed")
                print(out + err)
                failure_counter += 1
                continue

            # Check for "?? PythonTeX ??" markers in output text
            with open(os.path.join(test_dir, out_txt), "r", encoding="utf-8") as f:
                content = f.read()
                if "?? PythonTeX ??" in content:
                    print(f"{FAIL} - '?? PythonTeX ??' found in output (unprocessed PythonTeX code)")
                    failure_counter += 1
                    continue

            # Compare with expected text
            expected_txt = os.path.join("expected", base + ".pdf.txt")
            if os.path.exists(os.path.join(test_dir, expected_txt)):
                with (
                    open(os.path.join(test_dir, expected_txt), "r", encoding="utf-8") as exp_f,
                    open(os.path.join(test_dir, out_txt), "r", encoding="utf-8") as out_f
                ):
                    actual = normalize_text(out_f.read().strip())
                    expected = normalize_text(exp_f.read().strip())
                    if actual != expected:
                        _, out, err = run_command(
                            DIFF_CMD + [expected_txt, out_txt]
                            + ["-L", os.path.join(test_dir, expected_txt), "-L", os.path.join(test_dir, out_txt)],
                            cwd=test_dir)
                        print(f"{FAIL if not regold else REGOLDED} - Output differs (ignoring whitespaces)")
                        if not regold:
                            print(out + err)
                        else:
                            shutil.copy(os.path.join(test_dir, out_txt), os.path.join(test_dir, expected_txt))
                        failure_counter += 1
                        continue
            else:
                print(f"{FAIL if not regold else REGOLDED} - No expected output {os.path.join(test_dir, expected_txt)}. ")
                print("Copied current one for review. ")
                print(f"Suggestion: git add {os.path.join(test_dir, expected_txt)} after verifying it.")
                shutil.copy(os.path.join(test_dir, out_txt), os.path.join(test_dir, expected_txt))
                failure_counter += 1
                continue

            # Compare with expected notebooks
            ipynb_dir = f"notebooks-{base}"
            if os.path.isdir(os.path.join(test_dir, ipynb_dir)):
                generated_ipynbs = [
                    f for f in os.listdir(os.path.join(test_dir, ipynb_dir)) if f.endswith(".ipynb")]
                expected_ipynbs = [
                    f"{base}.{generated_ipynb}" for generated_ipynb in generated_ipynbs]

                failed_ipynbs = []
                for generated_ipynb, expected_ipynb in zip(generated_ipynbs, expected_ipynbs):
                    generated_ipynb = os.path.join(ipynb_dir, generated_ipynb)
                    expected_ipynb = os.path.join("expected", expected_ipynb)

                    if not os.path.exists(os.path.join(test_dir, expected_ipynb)):
                        failure = (
                            f"No expected notebook {os.path.join(test_dir, expected_ipynb)}. "
                            f"Copied current one for review. "
                            f"Suggestion: git add {os.path.join(test_dir, expected_ipynb)} after verifying it.")
                        failed_ipynbs.append(failure)
                        shutil.copy(os.path.join(test_dir, generated_ipynb), os.path.join(test_dir, expected_ipynb))

                    # Compare contents
                    with (
                        open(os.path.join(test_dir, expected_ipynb), "r", encoding="utf-8") as exp_f,
                        open(os.path.join(test_dir, generated_ipynb), "r", encoding="utf-8") as gen_f,
                    ):
                        exp_nb = normalize_notebook(json.load(exp_f))
                        gen_nb = normalize_notebook(json.load(gen_f))

                        if exp_nb != gen_nb:
                            _, out, err = run_command(NBDIFF_CMD + [expected_ipynb, generated_ipynb], cwd=test_dir)
                            out = out.replace(
                                f"--- {expected_ipynb}", f"--- {os.path.join(test_dir, expected_ipynb)}")
                            out = out.replace(
                                f"+++ {generated_ipynb}", f"+++ {os.path.join(test_dir, generated_ipynb)}")
                            failure = (
                                f"Notebook {os.path.join(test_dir, generated_ipynb)} differs "
                                "from the expected output:\n" + out + err
                            )
                            failed_ipynbs.append(failure)
                            if regold:
                                shutil.copy(os.path.join(test_dir, generated_ipynb), os.path.join(test_dir, expected_ipynb))

                if len(failed_ipynbs) > 0:
                    if not regold:
                        print(
                            f"{FAIL} - Comparison to expected notebooks failed for the following reasons:\n"
                            + "\n".join(failed_ipynbs))
                    else:
                        print(f"{REGOLDED} - Comparison to expected notebooks failed")
                    failure_counter += 1
                    continue

                current_expected_ipynbs = [
                    f for f in os.listdir(os.path.join(test_dir, "expected"))
                    if f.startswith(f"{base}.") and f.endswith(".ipynb")]
                expected_ipynbs_set = set(expected_ipynbs)
                current_expected_ipynbs_set = set(current_expected_ipynbs)
                missing_expected_ipynbs = expected_ipynbs_set - current_expected_ipynbs_set
                spurious_expected_ipynbs = current_expected_ipynbs_set - expected_ipynbs_set
                if missing_expected_ipynbs or spurious_expected_ipynbs:
                    print(f"{FAIL} - Mismatch between expected and actual notebooks:")
                    if missing_expected_ipynbs:
                        print("  Missing expected notebooks:")
                        for f in missing_expected_ipynbs:
                            print(f"    - {f}")
                    if spurious_expected_ipynbs:
                        print("  Spurious expected notebooks (no corresponding .ipynb):")
                        for f in spurious_expected_ipynbs:
                            print(f"    - {f}")
                    failure_counter += 1
                    continue

                # Run pytest in the ipynb_dir
                run_nbval = False
                for generated_ipynb in generated_ipynbs:
                    generated_ipynb = os.path.join(ipynb_dir, generated_ipynb)
                    with open(os.path.join(test_dir, generated_ipynb), "r", encoding="utf-8") as gen_f:
                        if notebook_has_code_cells(json.load(gen_f)):
                            run_nbval = True
                            break
                if run_nbval:
                    ret, out, err = run_command(["pytest", "--nbval"], cwd=os.path.join(test_dir, ipynb_dir))
                    if ret != 0:
                        print(f"{FAIL} - pytest failed running notebooks in pythontex directory")
                        print(out + err)
                        failure_counter += 1
                        continue

                # Clean up hidden files produced by nbval, otherwise latexmk will not be able to clean
                # the notebook directory
                remove_hidden_files_and_directories(os.path.join(test_dir, ipynb_dir))

            # If arrived here without existing it means that the test passed
            print(f"{PASS}")

        # Clean up
        run_command(CLEAN_CMD + [tex_file], cwd=test_dir)
        for require in requires:
            run_command(CLEAN_CMD + [require[1]], cwd=require[0])

    # Print test summary
    if failure_counter > 0:
        print(f"{SUMMARY}: {FAIL} with {failure_counter} failures")
        sys.exit(1)
    else:
        print(f"{SUMMARY}: {PASS}")


def is_in_xsim_files_dir(path: str) -> bool:
    """
    Check if the given file path is inside any directory whose name starts with "xsim-files".

    Parameters
    ----------
    path
        The file path to check.

    Returns
    -------
    :
        True if the path contains a directory starting with "xsim-files", False otherwise.
    """
    parts = path.split(os.sep)
    return any(part.startswith("xsim-files") for part in parts)


def main() -> None:
    """
    Run LaTeX tests filtered by command line arguments.

    If no arguments are given, all ``test_*.tex`` files in the current
    directory and its subdirectories are discovered and tested.

    If arguments are given, each can be:
      - A path to a single ``.tex`` file (tested directly).
      - A path to a directory, in which case all matching ``test_*.tex`` files
        inside it (recursively) will be discovered and tested.

    Exits
    -----
    Exits with code 1 if a specified file or directory does not exist, or if any test fails.
    """
    args = sys.argv[1:]

    # Determine if maxfail or regold were provided
    maxfail = sys.maxsize
    regold = False
    new_args = []
    for arg in args:
        if arg.startswith("--maxfail="):
            try:
                maxfail = int(arg.split("=")[1])
            except ValueError:
                print(f"Invalid value for --maxfail: {arg}")
                sys.exit(1)
        elif arg == "--regold":
            regold = True
        else:
            new_args.append(arg)
    args = new_args

    # Determine which tests to run
    tex_tests = []
    if args:
        for path in args:
            if os.path.isfile(path) and path.endswith(".tex"):
                # Single .tex file provided
                tex_tests.append(path)
            elif os.path.isdir(path):
                # Directory provided: search recursively for test_*.tex files
                found_files = sorted(glob.glob(os.path.join(path, "**", "test_*.tex"), recursive=True))
                # Filter out files in xsim-files directories
                filtered_files = [f for f in found_files if not is_in_xsim_files_dir(f)]
                tex_tests.extend(filtered_files)
            else:
                print(f"File or directory not found or unsupported: {path}")
                sys.exit(1)
    else:
        # Autodiscovery: search recursively in current directory
        found_files = sorted(glob.glob("**/test_*.tex", recursive=True))
        tex_tests = [f for f in found_files if not is_in_xsim_files_dir(f)]

    if tex_tests:
        run_latex_tests(tex_tests, maxfail, regold)


if __name__ == "__main__":
    main()
