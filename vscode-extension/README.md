# TeX Notebook Sync

TeX Notebook Sync adds a round-trip editing workflow to `tex-notebook.sty` to sync changes from `_texsync.ipynb` notebooks back to the source TeX file.

## 1. Supported synchronization operations

The extension operates only on filenames ending exactly in:

```text
_texsync.ipynb
```

Synchronization is automatic: when a `_texsync.ipynb` notebook is saved in VS Code, the extension reads the saved notebook and attempts to propagate its supported changes back to the source TeX file. No manual synchronization command is required.

The extension supports:

- editing existing `mdcell` and `pycell` bodies;
- adding Markdown cells as new `mdcell` environments;
- adding code cells as new `pycell` environments;
- deleting existing TeX-backed cells and their corresponding environments;
- conservative reordering in supported pure-cell enclosing environments;
- preservation of raw-TeX `\ref` / `\eqref` constructs when their rendered reference remains in edited Markdown;
- `pyexpectedoutput` / `\pyexpectedfigure` ownership by the immediately preceding `pycell`;
- package-generated read-only virtual cells as structural anchors;
- stale in-memory/workspace manifest recovery from current notebook metadata;
- local spacing normalization around touched cells:
  - exactly one blank line between touched consecutive `mdcell` / `pycell` environments;
  - no blank line between a touched `pycell` and its attached `pyexpectedoutput` / `\pyexpectedfigure` trailers;
  - unrelated pre-existing spacing is left untouched;
- TeX-side drift detection, refusing to overwrite source changes that no longer match the synchronization baseline;
- conflict-patch generation when TeX-side drift prevents automatic synchronization.

Markdown-to-code and code-to-Markdown conversion is intentionally unsupported.

The extension does not rewrite synchronization metadata back into the notebook after saving. Its synchronization state is maintained separately so that it can coexist with notebook-metadata cleaning extensions.

If an ordinary production notebook such as:

```text
lecture.ipynb
```

is opened while the companion:

```text
lecture_texsync.ipynb
```

exists in the same directory, the extension shows a modal warning asking whether to open the `_texsync.ipynb` notebook instead. If that option is selected, the `_texsync.ipynb` notebook is opened and the production notebook tab is closed.

## 2. Install the VS Code extension

Build the VSIX from the extension source directory:

```bash
npx @vscode/vsce package
```

Install or replace the extension with:

```bash
code --install-extension tex-notebook-sync-*.vsix --force
```

## 3. Typical workflow

```text
compile TeX
    -> lecture.ipynb
    -> lecture_texsync.ipynb

open lecture_texsync.ipynb in VS Code
    -> edit Markdown/code cells
    -> save the notebook
    -> notebook is saved normally
    -> TeX Notebook Sync automatically attempts reverse synchronization
        -> if safe: source .tex is updated
        -> if conflicting: source .tex is left untouched and
                           lecture_texsync.conflict.patch is written/updated

compile TeX again after successful synchronization
    -> refreshed lecture.ipynb
    -> refreshed lecture_texsync.ipynb baseline
```

The production `.ipynb` file is intended for normal use and distribution. The `_texsync.ipynb` file carries the additional synchronization information required for reverse synchronization and is the notebook that should be edited when changes are intended to flow back to TeX.

## 4. Conflict handling

A TeX-side conflict must not cause notebook edits to be lost. Synchronization therefore runs after the notebook itself has been saved.

If the current TeX source has diverged from the last synchronized snapshot in a way that makes reverse synchronization unsafe:

- the `_texsync.ipynb` notebook remains saved;
- the source `.tex` file is not modified;
- a sibling conflict file is written or updated:

```text
lecture_texsync.conflict.patch
```

The conflict patch contains a unified diff from the last successfully synchronized TeX snapshot to the TeX requested by the current notebook. It intentionally does not encode unrelated current-TeX edits as reversions.

Its header records the synchronization context, including the notebook/source paths, snapshot/current/requested hashes, and current-versus-snapshot divergence information.

Repeated conflicted saves update the same `.conflict.patch` so that it reflects the latest saved notebook state.

An existing conflict patch is not deleted automatically after a later successful synchronization; remove it manually after the conflict has been reviewed and resolved.

After resolving a conflict in TeX, regenerate the production and `_texsync` notebooks before continuing reverse synchronization.

## 5. Tests

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
- preservation of pre-existing non-canonical spacing at unrelated, untouched cell boundaries;
- conflict-patch filename generation for `_texsync.ipynb` notebooks;
- unified conflict-patch generation from the last synchronized TeX snapshot to the TeX requested by the current notebook;
- conflict patches containing multiple separated diff hunks;
- preservation of unrelated edits in the current TeX source, which must not appear as reversions in the notebook-intent patch;
- reporting of current-TeX versus synchronized-snapshot divergence;
- conflict handling when the current notebook requests no TeX changes;
- unified-diff correctness for TeX files both with and without a final newline.

Run them from the source directory with:

```bash
npm test
```
