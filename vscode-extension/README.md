# TeX Notebook Sync
TeX Notebook Sync adds a round-trip editing workflow to `tex-notebook.sty` to sync changes from `_texsync.ipynb` notebooks back to the source tex file.

## 1. Supported synchronization operations

Available commands:

- **TeX Notebook: Sync Notebook to LaTeX**
- **TeX Notebook: Open LaTeX Source**

The extension operates only on filenames ending exactly in:

```text
_texsync.ipynb
```

Such commands are hidden/disabled for ordinary notebooks.

The extension supports:

- editing existing `mdcell` and `pycell` bodies;
- adding Markdown cells as new `mdcell` environments;
- adding code cells as new `pycell` environments;
- deleting existing TeX-backed cells and their corresponding environments;
- conservative reordering in supported pure-cell enclosing environments;
- preservation of raw-TeX `\ref` / `\eqref` constructs when their rendered reference remains in edited Markdown;
- TeX-side drift detection, aborting instead of overwriting conflicting source changes;
- package-generated read-only virtual cells as structural anchors.

Markdown-to-code and code-to-Markdown conversion is intentionally unsupported.

## 2. Install the VS Code extension

```bash
npx @vscode/vsce package
code --install-extension tex-notebook-sync-*.vsix --force
```

## 3. Typical workflow

```text
compile TeX
    -> lecture.ipynb
    -> lecture_texsync.ipynb

edit lecture_texsync.ipynb in VS Code
    -> Sync Notebook to LaTeX
    -> production .tex is updated

compile TeX again
    -> refreshed lecture.ipynb
    -> refreshed lecture_texsync.ipynb baseline
```

## 4. Tests

The source bundle includes tests for:

- filename gating (`*_texsync.ipynb` only);
- clean vs synchronization notebook output;
- modify/add/delete behavior;
- `pyexpectedoutput` / `\pyexpectedfigure` ownership;
- `\ref` / `\eqref` restoration;
- enclosing-environment placement;
- generated read-only `pyexercise` headings, including empty exercises and stale line hints;
- duplicate-cell handling;
- XSIM provenance integration anchors for exercise, solution, and additional-information replay;
- commented-out fake cells and fake parent environments;
- `comment`, `verbatim`, `Verbatim`, `lstlisting`, and `minted` regions containing cell-like text;
- metadata stripping;
- stale in-memory/workspace manifest recovery from current notebook metadata;
- informative unknown-sync-ID diagnostics, including 1-based global cell index, cell type, source preview, and offending sync ID;
- production-notebook to `_texsync.ipynb` companion filename mapping;
- local cell-spacing normalization after modify/add/delete/move operations;
- exactly one blank line at touched `mdcell` / `pycell` boundaries;
- no blank line between a touched `pycell` and its `pyexpectedoutput` / `\pyexpectedfigure` trailers;
- preservation of pre-existing non-canonical spacing at unrelated, untouched cell boundaries.

Run them from the source directory with:

```bash
npm test
```
