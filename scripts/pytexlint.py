"""Run ruff and ty checks on Python code embedded in LaTeX."""

import argparse
import dataclasses
import json
import os
import pathlib
import re
import subprocess
import tempfile

PYCELL_BEGIN_RE = re.compile(r"\\begin\{pycell\}(?:\[[^\]]*\])?")
PYCELL_END_RE = re.compile(r"\\end\{pycell\}")
PYN_COUNTER_STEP_RE = re.compile(
    r"\\(?:stepcounter|refstepcounter)\{pynotebook\}"
)
PYN_COUNTER_ADD_RE = re.compile(r"\\addtocounter\{pynotebook\}\{(\d+)\}")
PYN_COUNTER_SET_RE = re.compile(r"\\setcounter\{pynotebook\}\{(\d+)\}")
PYN_ENV_EXERCISE_RE = re.compile(
    r"\\begin\{(?:exercise|solution|additionalinformation)\}"
)
PYN_CHAPTER_RE = re.compile(r"\\chapter(?:\*?)\s*\{")
USEPACKAGE_RE = re.compile(r"\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}")


@dataclasses.dataclass(frozen=True)
class PyCellBlock:
    r"""
    Representation of a single ``pycell`` block inside a LaTeX file.

    Parameters
    ----------
    begin_line_idx : int
        Index (0-based) of the line that contains ``\begin{pycell}``.
    code_start_line_idx : int
        Index (0-based) of the first line of Python code inside the block.
    code_end_line_idx_exclusive : int
        Exclusive end index (0-based) for the code lines (the line before
        ``\end{pycell}``).
    end_line_idx : int
        Index (0-based) of the line that contains ``\end{pycell}``.
    """

    begin_line_idx: int
    code_start_line_idx: int
    code_end_line_idx_exclusive: int
    end_line_idx: int


@dataclasses.dataclass(frozen=True)
class TexExtraction:
    """
    Container holding parsed information for a single ``.tex`` file.

    Parameters
    ----------
    path : Path
        Path to the original LaTeX file.
    lines : list[str]
        Original file content as a list of lines (including line endings).
    pycell_blocks : list[PyCellBlock]
        List of discovered ``pycell`` blocks in the file.
    """

    path: pathlib.Path
    lines: list[str]
    pycell_blocks: list[PyCellBlock]


def run_command(
    command: list[str], *, stdin_text: str | None = None
) -> tuple[int, str, str]:
    """
    Run an external command and capture its output.

    Parameters
    ----------
    command : list[str]
        Command and arguments to execute.
    stdin_text : str or None, optional
        Text to pass to the subprocess standard input.

    Returns
    -------
    tuple
        A tuple ``(returncode, stdout, stderr)`` with decoded strings.
    """
    result = subprocess.run(
        command,
        input=stdin_text,
        capture_output=True,
        text=True,
    )
    return result.returncode, result.stdout, result.stderr


def find_pycell_blocks(
    tex_lines: list[str], source_path: pathlib.Path
) -> list[PyCellBlock]:
    """
    Locate all ``pycell`` blocks in a list of LaTeX file lines.

    Parameters
    ----------
    tex_lines : list[str]
        File content as lines (including line endings).
    source_path : Path
        Path to the source file (used for error messages).

    Returns
    -------
    list[PyCellBlock]
        A list of :class:`PyCellBlock` instances describing each discovered
        block.

    Raises
    ------
    ValueError
        If a ``pycell`` begin marker is found without a matching end marker.
    """
    blocks: list[PyCellBlock] = []
    current_begin: int | None = None

    for idx, line in enumerate(tex_lines):
        if current_begin is None:
            if PYCELL_BEGIN_RE.search(line):
                current_begin = idx
            continue

        if PYCELL_END_RE.search(line):
            blocks.append(
                PyCellBlock(
                    begin_line_idx=current_begin,
                    code_start_line_idx=current_begin + 1,
                    code_end_line_idx_exclusive=idx,
                    end_line_idx=idx,
                )
            )
            current_begin = None

    if current_begin is not None:
        raise ValueError(
            f"Unclosed pycell in {source_path} starting at line "
            f"{current_begin + 1}."
        )

    return blocks


def parse_tex_file(path: pathlib.Path) -> TexExtraction:
    """
    Parse a LaTeX file and return a :class:`TexExtraction`.

    Parameters
    ----------
    path : Path
        Path to the LaTeX file to parse.

    Returns
    -------
    TexExtraction
        Extraction info including original lines and discovered pycell blocks.
    """
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    blocks = find_pycell_blocks(lines, path)
    return TexExtraction(path=path, lines=lines, pycell_blocks=blocks)


def discover_tex_files(paths: list[str]) -> list[pathlib.Path]:
    """
    Discover ``.tex`` files from a list of input paths.

    Parameters
    ----------
    paths : list[str]
        A list of files and/or directories. Files are included only if they
        have a ``.tex`` suffix; directories are searched recursively.

    Returns
    -------
    list[Path]
        Sorted list of discovered ``.tex`` file paths.

    Raises
    ------
    FileNotFoundError
        If any provided path does not exist.
    """
    discovered: list[pathlib.Path] = []
    seen: set[pathlib.Path] = set()

    for raw_path in paths:
        path = pathlib.Path(raw_path)
        if not path.exists():
            raise FileNotFoundError(f"Path does not exist: {path}")

        if path.is_file() and path.suffix == ".tex":
            resolved = path.resolve()
            if resolved not in seen:
                seen.add(resolved)
                discovered.append(path)
            continue

        if path.is_dir():
            for tex_path in sorted(path.rglob("*.tex")):
                resolved = tex_path.resolve()
                if resolved not in seen:
                    seen.add(resolved)
                    discovered.append(tex_path)

    return sorted(discovered)


def extract_python_for_lint(extraction: TexExtraction) -> str:
    """
    Produce a temporary Python source string for linting.

    The returned string preserves original line numbers by filling non-Python
    lines with empty lines. This allows Ruff diagnostics to reference the same
    line numbers as the original LaTeX file.

    Parameters
    ----------
    extraction : TexExtraction
        Parsed LaTeX file information.

    Returns
    -------
    str
        Python source text suitable to be written to a temporary ``.py`` file.
    """
    py_lines = ["\n"] * len(extraction.lines)
    for block in extraction.pycell_blocks:
        for idx in range(
            block.code_start_line_idx, block.code_end_line_idx_exclusive
        ):
            py_lines[idx] = extraction.lines[idx]
    return "".join(py_lines)


def format_pycell_code(
    ruff_bin: str, code: str, source_path: pathlib.Path, line_number: int
) -> str:
    """
    Format a code snippet using ``ruff format``.

    Parameters
    ----------
    ruff_bin : str
        Path or executable name of the ``ruff`` binary.
    code : str
        Python code to format.
    source_path : Path
        Original source file path used for the ``--stdin-filename`` hint.
    line_number : int
        Line number to attach to the provided code (1-based). This helps
        ``ruff`` report consistent locations when formatting fragments.

    Returns
    -------
    str
        Formatted code as returned by ``ruff`` on stdout.

    Raises
    ------
    RuntimeError
        If the ``ruff format`` invocation returns a non-zero exit code.
    """
    command = [
        ruff_bin,
        "format",
        "--stdin-filename",
        str(source_path),
        "-",
    ]
    ret, out, err = run_command(command, stdin_text=code)
    if ret != 0:
        raise RuntimeError(
            "ruff format failed for "
            f"{source_path}:{line_number}\n{out}{err}".rstrip()
        )
    return out


def format_tex_files(
    extractions: list[TexExtraction], *, check_only: bool, ruff_bin: str
) -> int:
    """
    Format all discovered pycell blocks and optionally write changes.

    Parameters
    ----------
    extractions : list[TexExtraction]
        Parsed LaTeX files to process.
    check_only : bool
        If True, only report which files would change and do not write.
    ruff_bin : str
        Path or executable name of the ``ruff`` binary.

    Returns
    -------
    int
        Exit code: ``0`` when successful or nothing to change, ``1`` when
        files would be changed in check-only mode.
    """
    changed_files: list[pathlib.Path] = []
    format_errors = 0

    for extraction in extractions:
        if not extraction.pycell_blocks:
            continue

        new_lines = extraction.lines.copy()
        file_changed = False

        for block in sorted(
            extraction.pycell_blocks,
            key=lambda b: b.code_start_line_idx,
            reverse=True,
        ):
            original = "".join(
                new_lines[
                    block.code_start_line_idx : block.code_end_line_idx_exclusive  # noqa: E501
                ]
            )
            try:
                formatted = format_pycell_code(
                    ruff_bin,
                    original,
                    extraction.path,
                    block.code_start_line_idx + 1,
                )
            except RuntimeError as exc:
                print(exc)
                format_errors += 1
                continue
            if original != formatted:
                replacement = formatted.splitlines(keepends=True)
                new_lines[
                    block.code_start_line_idx : block.code_end_line_idx_exclusive  # noqa: E501
                ] = replacement
                file_changed = True

        if file_changed:
            changed_files.append(extraction.path)
            if not check_only:
                extraction.path.write_text("".join(new_lines), encoding="utf-8")

    if format_errors:
        return 2

    if check_only:
        if changed_files:
            print("The following TeX files need formatting:")
            for path in changed_files:
                print(path)
            return 1
        print("All TeX files are properly formatted.")
        return 0

    if changed_files:
        print("Formatted TeX files:")
        for path in changed_files:
            print(path)
    else:
        print("No TeX files needed formatting.")
    return 0


def lint_tex_files(
    extractions: list[TexExtraction],
    *,
    ruff_bin: str,
    extra_args: list[str],
    fix: bool = False,
    unsafe_fixes: bool = False,
) -> int:
    """
    Run ``ruff check`` on Python code extracted from LaTeX files.

    The function writes temporary ``.py`` files that preserve original
    line numbers and invokes ``ruff check --output-format json``. Any
    diagnostics found are remapped back to the original ``.tex`` filename
    and printed in a human-readable ``filename:row:col: CODE message``
    format.

    If ``fix`` or ``unsafe_fixes`` is True, Ruff fixes are applied first
    on a per-logical-notebook-segment basis via stdin.  Within each segment
    all pycell blocks are concatenated at module scope (separated by comment
    markers), so that cross-cell import analysis mirrors the behaviour of
    ``ruff check --fix`` on a Jupyter notebook.  Fixed code is written back
    into the original ``.tex`` files before a final (non-fixing) pass that
    collects diagnostics.

    Parameters
    ----------
    extractions : list[TexExtraction]
        Parsed LaTeX files to lint.
    ruff_bin : str
        Path or executable name of the ``ruff`` binary.
    extra_args : list[str]
        Additional arguments passed to ``ruff check`` (typically after ``--``).

    Returns
    -------
    int
        Exit code: ``0`` no violations, ``1`` violations found, ``2`` if a
        ruff invocation failed unexpectedly.
    """
    violations: list[tuple[str, int, int, str, str]] = []
    parse_errors = 0

    def group_blocks_by_notebook(
        extraction: TexExtraction,
    ) -> dict[int, list[PyCellBlock]]:
        """Group pycell blocks by logical notebook index."""
        packages: set[str] = set()
        for line in extraction.lines:
            match = USEPACKAGE_RE.search(line)
            if match:
                for package_name in match.group(1).split(","):
                    packages.add(package_name.strip())

        treat_env_as_increment = any(
            pkg in packages for pkg in ("tests-exercise-book", "exercise-book")
        )
        treat_chapter_as_increment = any(
            pkg in packages
            for pkg in ("tests-tex-notebook", "pybeamerlecturenotes")
        )

        counter = 0
        counters_at_line: list[int] = [0] * len(extraction.lines)
        for i, line in enumerate(extraction.lines):
            m_set = PYN_COUNTER_SET_RE.search(line)
            if m_set:
                try:
                    counter = int(m_set.group(1))
                except Exception:
                    pass
            m_add = PYN_COUNTER_ADD_RE.search(line)
            if m_add:
                try:
                    counter += int(m_add.group(1))
                except Exception:
                    pass
            if PYN_COUNTER_STEP_RE.search(line):
                counter += 1
            if treat_env_as_increment and PYN_ENV_EXERCISE_RE.search(line):
                counter += 1
            if treat_chapter_as_increment and PYN_CHAPTER_RE.search(line):
                counter += 1
            counters_at_line[i] = counter

        groups: dict[int, list[PyCellBlock]] = {}
        for block in extraction.pycell_blocks:
            idx = (
                counters_at_line[block.begin_line_idx]
                if 0 <= block.begin_line_idx < len(counters_at_line)
                else 0
            )
            groups.setdefault(idx, []).append(block)
        return groups

    # Do not check against rules that are not relevant for noteboks, or that
    # have a different behavior for notebooks vs plain python files, see
    # * B015,B018,D100,E402,E703: https://github.com/astral-sh/ruff/issues/8669
    # * I001: gives false positives when the cell contains only imports
    # Checking against those rules will only be possible once the notebook
    # is actually generated.
    additional_ignores = ["--ignore", "B015,B018,D100,E402,E703,I001"]

    # Apply Ruff fixes back into the .tex source.
    # Blocks are grouped by logical notebook segment so that cross-cell
    # import usage is visible to Ruff (matching how ``ruff check --fix``
    # behaves on a Jupyter notebook with cross-cell analysis).  Within each
    # segment all pycell blocks are concatenated at module scope, separated
    # only by lightweight comment markers.  This means:
    #   - F401 (unused import) only fires for imports that are unused across
    #     the entire segment, not merely unused in one cell.
    #   - E302 (blank lines before function/class) is applied within cells
    #     where code precedes a definition, without bleeding into adjacent
    #     cells (marker comment lines serve as a natural separator).
    # Segments are processed in reverse order so that line-count changes in
    # one segment do not shift indices for earlier segments.
    if fix or unsafe_fixes:
        for extraction in extractions:
            if not extraction.pycell_blocks:
                continue

            file_changed = False
            groups = group_blocks_by_notebook(extraction)
            ordered_segments = sorted(
                groups.items(),
                key=lambda item: min(b.code_start_line_idx for b in item[1]),
                reverse=True,
            )

            for seg_idx, blocks in ordered_segments:
                blocks_in_order = sorted(
                    blocks, key=lambda b: b.code_start_line_idx
                )

                # Build a wrapper that places each block's code at module
                # scope, delimited by uniquely named comment markers so that
                # the fixed code for each block can be extracted afterwards.
                # Two blank lines are inserted between blocks so that Ruff's
                # E302 rule (two blank lines before a module-level
                # function/class) is satisfied in the gap between markers and
                # does not inject trailing blank lines into the preceding
                # block's content.
                wrapper_lines: list[str] = []
                for block_idx, block in enumerate(blocks_in_order):
                    if block_idx > 0:
                        wrapper_lines.append("\n")
                        wrapper_lines.append("\n")
                    wrapper_lines.append(
                        f"# __PYCELL_START_{seg_idx}_{block_idx}__\n"
                    )
                    original_lines = "".join(
                        extraction.lines[
                            block.code_start_line_idx : block.code_end_line_idx_exclusive  # noqa: E501
                        ]
                    ).splitlines(keepends=True)
                    if original_lines:
                        wrapper_lines.extend(original_lines)
                    else:
                        wrapper_lines.append("pass\n")
                    wrapper_lines.append(
                        f"# __PYCELL_END_{seg_idx}_{block_idx}__\n"
                    )

                wrapper_text = "".join(wrapper_lines)
                fix_cmd = [
                    ruff_bin,
                    "check",
                    *additional_ignores,
                    *extra_args,
                    "--fix",
                ]
                if unsafe_fixes:
                    fix_cmd.append("--unsafe-fixes")
                fix_cmd += [
                    "--stdin-filename",
                    str(extraction.path),
                    "-",
                ]

                fret, fout, ferr = run_command(fix_cmd, stdin_text=wrapper_text)
                if fret not in (0, 1):
                    print(
                        f"ruff --fix failed for {extraction.path} "
                        f"(segment {seg_idx})"
                    )
                    if ferr:
                        print(ferr, end="" if ferr.endswith("\n") else "\n")
                    parse_errors += 1
                    continue

                # Extract the fixed content for each block from the fixed
                # wrapper, then write any changes back into extraction.lines.
                fixed_lines = fout.splitlines(keepends=True)
                for block_idx, block in sorted(
                    enumerate(blocks_in_order),
                    key=lambda pair: pair[1].code_start_line_idx,
                    reverse=True,
                ):
                    start_marker = f"# __PYCELL_START_{seg_idx}_{block_idx}__\n"
                    end_marker = f"# __PYCELL_END_{seg_idx}_{block_idx}__\n"
                    try:
                        s = fixed_lines.index(start_marker)
                        e = fixed_lines.index(end_marker, s + 1)
                    except ValueError:
                        continue

                    replacement = fixed_lines[s + 1 : e]
                    # Strip trailing blank lines: inter-cell separators
                    # (E302, I001) may inject them at the end of a block
                    # rather than between the markers where they belong.
                    while replacement and replacement[-1] == "\n":
                        replacement = replacement[:-1]
                    if replacement == ["pass\n"]:
                        # Normalise back: an empty block that was padded with
                        # ``pass`` should remain empty in the .tex source.
                        original_was_empty = not any(
                            extraction.lines[
                                block.code_start_line_idx : block.code_end_line_idx_exclusive  # noqa: E501
                            ]
                        )
                        if original_was_empty:
                            replacement = []

                    start = block.code_start_line_idx
                    end = block.code_end_line_idx_exclusive
                    if extraction.lines[start:end] != replacement:
                        extraction.lines[start:end] = replacement
                        file_changed = True

            if file_changed:
                extraction.path.write_text(
                    "".join(extraction.lines), encoding="utf-8"
                )

        if parse_errors:
            return 2

        refreshed = [
            parse_tex_file(extraction.path) for extraction in extractions
        ]
        return lint_tex_files(
            refreshed,
            ruff_bin=ruff_bin,
            extra_args=extra_args,
            fix=False,
            unsafe_fixes=False,
        )
    else:
        for extraction in extractions:
            if not extraction.pycell_blocks:
                continue

            file_changed = False
            groups = group_blocks_by_notebook(extraction)

            for seg_idx, blocks in groups.items():
                py_lines = ["\n"] * len(extraction.lines)
                for block in blocks:
                    for li in range(
                        block.code_start_line_idx,
                        block.code_end_line_idx_exclusive,
                    ):
                        py_lines[li] = extraction.lines[li]
                py_content = "".join(py_lines)

                # Run Ruff on this notebook segment. We pass the original .tex
                # path as stdin filename so per-file-ignores on TeX paths apply.

                command = [
                    ruff_bin,
                    "check",
                    "--output-format",
                    "json",
                    *additional_ignores,
                    *extra_args,
                    "--stdin-filename",
                    str(extraction.path),
                    "-",
                ]
                ret, out, err = run_command(command, stdin_text=py_content)

                if ret not in (0, 1):
                    print(
                        f"ruff check failed for {extraction.path} "
                        f"(segment {seg_idx})"
                    )
                    if out:
                        print(out, end="" if out.endswith("\n") else "\n")
                    if err:
                        print(err, end="" if err.endswith("\n") else "\n")
                    parse_errors += 1
                    continue

                if not out.strip():
                    continue

                data = json.loads(out)
                for entry in data:
                    location = entry.get("location")
                    if not isinstance(location, dict):
                        continue
                    row = location.get("row")
                    column = location.get("column")
                    code = entry.get("code")
                    message = entry.get("message")
                    if (
                        isinstance(row, int)
                        and isinstance(column, int)
                        and isinstance(code, str)
                        and isinstance(message, str)
                    ):
                        violations.append(
                            (str(extraction.path), row, column, code, message)
                        )

            if file_changed:
                extraction.path.write_text(
                    "".join(extraction.lines), encoding="utf-8"
                )

        if parse_errors:
            return 2

        if not violations:
            print("No lint violations found in pycell blocks.")
            return 0

        for filename, row, column, code, message in sorted(
            violations,
            key=lambda entry: (entry[0], entry[1], entry[2], entry[3]),
        ):
            print(f"{filename}:{row}:{column}: {code} {message}")

        return 1


def ty_check_tex_files(
    extractions: list[TexExtraction], *, ty_bin: str, extra_args: list[str]
) -> int:
    """Run ``ty check`` on Python code extracted from LaTeX files."""
    diagnostics_found = False
    check_errors = 0

    for extraction in extractions:
        if not extraction.pycell_blocks:
            continue

        py_content = extract_python_for_lint(extraction)
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".py",
            delete=False,
            encoding="utf-8",
        ) as tmpf:
            tmpf.write(py_content)
            tmp_path = pathlib.Path(tmpf.name)

        command = [ty_bin, "check", *extra_args, str(tmp_path)]
        ret, out, err = run_command(command)

        try:
            tmp_path.unlink()
        except OSError:
            pass

        if out:
            printed = out.replace(str(tmp_path), str(extraction.path))
            print(printed, end="" if printed.endswith("\n") else "\n")
        if err:
            printed = err.replace(str(tmp_path), str(extraction.path))
            print(printed, end="" if printed.endswith("\n") else "\n")

        if ret == 1:
            diagnostics_found = True
        elif ret != 0:
            check_errors += 1

    if check_errors:
        return 2
    if diagnostics_found:
        return 1

    print("No type violations found in pycell blocks.")
    return 0


def build_arg_parser() -> argparse.ArgumentParser:
    """
    Build and return the argument parser for the CLI.

    Returns
    -------
    argparse.ArgumentParser
        Configured parser with ``format``, ``lint``, and ``check`` subcommands.
    """
    parser = argparse.ArgumentParser(
        description=(
            "Run Ruff and Ty checks on Python code inside "
            "\\begin{pycell}...\\end{pycell} blocks in .tex files."
        )
    )
    subparsers = parser.add_subparsers(dest="tool", required=True)

    ruff_parser = subparsers.add_parser(
        "ruff", help="Use Ruff for checks/formatting."
    )
    ruff_parser.add_argument(
        "--ruff-bin",
        default=os.environ.get("RUFF_BIN", "ruff"),
        help="Ruff executable to use (default: ruff or $RUFF_BIN).",
    )
    ruff_subparsers = ruff_parser.add_subparsers(
        dest="ruff_command", required=True
    )

    format_parser = ruff_subparsers.add_parser(
        "format", help="Apply Ruff formatting to pycell blocks."
    )
    format_parser.add_argument(
        "--check",
        action="store_true",
        help=(
            "Check whether formatting would change any file, "
            "without writing changes."
        ),
    )
    format_parser.add_argument(
        "paths", nargs="+", help=".tex files or directories to process."
    )

    lint_parser = ruff_subparsers.add_parser(
        "lint", help="Run Ruff lint checks on pycell blocks."
    )
    lint_parser.add_argument(
        "paths", nargs="+", help=".tex files or directories to process."
    )
    lint_parser.add_argument(
        "--fix",
        action="store_true",
        help="Ask Ruff to apply safe fixes (passes --fix to ruff).",
    )
    lint_parser.add_argument(
        "--unsafe-fixes",
        action="store_true",
        help="Ask Ruff to apply unsafe fixes (passes --unsafe-fixes to ruff).",
    )
    lint_parser.add_argument(
        "ruff_args",
        nargs=argparse.REMAINDER,
        help="Additional arguments passed to 'ruff check' (prefix with '--').",
    )

    check_parser = ruff_subparsers.add_parser("check", help="Alias for 'lint'.")
    check_parser.add_argument(
        "paths", nargs="+", help=".tex files or directories to process."
    )
    check_parser.add_argument(
        "--fix",
        action="store_true",
        help="Ask Ruff to apply safe fixes (passes --fix to ruff).",
    )
    check_parser.add_argument(
        "--unsafe-fixes",
        action="store_true",
        help="Ask Ruff to apply unsafe fixes (passes --unsafe-fixes to ruff).",
    )
    check_parser.add_argument(
        "ruff_args",
        nargs=argparse.REMAINDER,
        help="Additional arguments passed to 'ruff check' (prefix with '--').",
    )

    ty_parser = subparsers.add_parser("ty", help="Use Ty for type checks.")
    ty_parser.add_argument(
        "--ty-bin",
        default=os.environ.get("TY_BIN", "ty"),
        help="Ty executable to use (default: ty or $TY_BIN).",
    )
    ty_subparsers = ty_parser.add_subparsers(dest="ty_command", required=True)
    ty_check_parser = ty_subparsers.add_parser(
        "check", help="Run Ty type checks on pycell blocks."
    )
    ty_check_parser.add_argument(
        "paths", nargs="+", help=".tex files or directories to process."
    )
    ty_check_parser.add_argument(
        "ty_args",
        nargs=argparse.REMAINDER,
        help="Additional arguments passed to 'ty check' (prefix with '--').",
    )

    return parser


def normalize_ruff_args(args: list[str]) -> list[str]:
    """
    Normalize argument list passed after a ``--`` separator.

    Parameters
    ----------
    args : list[str]
        Raw argument list from ``argparse`` when using
        ``nargs=argparse.REMAINDER``.

    Returns
    -------
    list[str]
        Arguments forwarded to ``ruff`` with an optional leading ``--`` removed.
    """
    if args and args[0] == "--":
        return args[1:]
    return args


def main() -> int:
    """
    Command-line entrypoint.

    Parses arguments and dispatches to the appropriate subcommand.

    Returns
    -------
    int
        Exit code to be returned to the shell.
    """
    parser = build_arg_parser()
    args = parser.parse_args()

    tex_files = discover_tex_files(args.paths)
    if not tex_files:
        print("No .tex files found in the provided paths.")
        return 0

    extractions = [parse_tex_file(path) for path in tex_files]

    if args.tool == "ruff":
        if args.ruff_command == "format":
            return format_tex_files(
                extractions, check_only=args.check, ruff_bin=args.ruff_bin
            )

        if args.ruff_command in {"lint", "check"}:
            ruff_args = normalize_ruff_args(args.ruff_args)
            return lint_tex_files(
                extractions,
                ruff_bin=args.ruff_bin,
                extra_args=ruff_args,
                fix=getattr(args, "fix", False),
                unsafe_fixes=getattr(args, "unsafe_fixes", False),
            )

        parser.error(f"Unsupported ruff command: {args.ruff_command}")
        return 2

    if args.tool == "ty":
        if args.ty_command == "check":
            ty_args = normalize_ruff_args(args.ty_args)
            return ty_check_tex_files(
                extractions,
                ty_bin=args.ty_bin,
                extra_args=ty_args,
            )

        parser.error(f"Unsupported ty command: {args.ty_command}")
        return 2

    parser.error(f"Unsupported tool: {args.tool}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
