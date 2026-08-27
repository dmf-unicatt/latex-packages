'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const {
  SyncError,
  syncNotebookToTex,
  minimalReplacement,
  isTexSyncNotebookPath,
  texSyncCompanionPath,
  TEXSYNC_NOTEBOOK_SUFFIX,
} = require('./syncCore');

const sessionStates = new Map();

function notebookPath(notebook) {
  return notebook.uri.fsPath || notebook.uri.path || '';
}

function rawNotebookMetadata(notebook) {
  // VS Code's built-in ipynb serializer exposes raw notebook.metadata under
  // NotebookDocument.metadata.metadata. Keep a direct-layout fallback for other serializers.
  const outer = notebook.metadata || {};
  return outer.metadata && typeof outer.metadata === 'object' ? outer.metadata : outer;
}

function notebookManifestFromMetadata(notebook) {
  const meta = rawNotebookMetadata(notebook).tex_notebook;
  return meta && typeof meta === 'object' ? meta : null;
}

function rawCellMetadata(cell) {
  const outer = cell.metadata || {};
  return outer.metadata && typeof outer.metadata === 'object' ? outer.metadata : outer;
}

function cellKind(cell) {
  return cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown';
}

function normalizeCodeSourceForState(source) {
  // check-jupyter-metadata-action/clean_notebook.py strips trailing whitespace
  // from code cells. Ignore that transformation when validating a persisted
  // extension-side sync baseline after reopening a notebook.
  return source.split(/\r?\n/).map(line => line.trimEnd()).join('\n');
}

function sourceMatchesManifestCell(cell, manifestCell) {
  if (!manifestCell || cellKind(cell) !== manifestCell.cell_type) return false;
  const current = cell.document.getText();
  const baseline = typeof manifestCell.generated_source === 'string'
    ? manifestCell.generated_source
    : '';
  if (cellKind(cell) === 'code') {
    return normalizeCodeSourceForState(current) === normalizeCodeSourceForState(baseline);
  }
  return current === baseline;
}

function manifestMatchesNotebook(manifest, notebook) {
  if (!manifest || manifest.schema_version !== 1 || !Array.isArray(manifest.cells)) return false;
  const cells = notebook.getCells();
  if (cells.length !== manifest.cells.length) return false;
  return cells.every((cell, index) => sourceMatchesManifestCell(cell, manifest.cells[index]));
}

function stateKey(notebook) {
  return `texNotebookSync.state.${notebook.uri.toString()}`;
}

function makeSessionState(manifest, notebook) {
  const cellIds = new WeakMap();
  const cells = notebook.getCells();
  if (manifest && Array.isArray(manifest.cells) && manifest.cells.length === cells.length) {
    cells.forEach((cell, index) => {
      const rawId = rawCellMetadata(cell).tex_notebook?.sync_id || null;
      const manifestId = manifest.cells[index]?.sync_id || null;
      if (rawId && manifest.cells.some(entry => entry.sync_id === rawId)) {
        cellIds.set(cell, rawId);
      } else if (manifestId && sourceMatchesManifestCell(cell, manifest.cells[index])) {
        cellIds.set(cell, manifestId);
      }
    });
  }
  return { manifest, cellIds };
}

function initializeNotebookState(context, notebook) {
  const filePath = notebookPath(notebook);
  if (!isTexSyncNotebookPath(filePath) || notebook.isUntitled) return null;

  const key = notebook.uri.toString();
  if (sessionStates.has(key)) return sessionStates.get(key);

  const metadataManifest = notebookManifestFromMetadata(notebook);
  const persisted = context.workspaceState.get(stateKey(notebook));
  const persistedManifest = persisted && typeof persisted === 'object' ? persisted.manifest : null;

  let manifest = null;
  const metadataMatches = manifestMatchesNotebook(metadataManifest, notebook);
  const persistedMatches = manifestMatchesNotebook(persistedManifest, notebook);

  // A regenerated _texsync notebook carries the authoritative fresh manifest.
  // If the notebook on disk still contains an older manifest from before an
  // automatic TeX sync, the extension-side persisted baseline matches the
  // current cells while the old notebook metadata does not, so prefer it.
  if (metadataMatches) manifest = metadataManifest;
  if (persistedMatches && !metadataMatches) manifest = persistedManifest;
  if (!manifest && metadataManifest) manifest = metadataManifest;

  if (!manifest) return null;
  const state = makeSessionState(manifest, notebook);
  sessionStates.set(key, state);
  return state;
}

async function refreshStateFromNotebookMetadataIfNeeded(context, notebook, state) {
  const metadataManifest = notebookManifestFromMetadata(notebook);
  if (!metadataManifest || !Array.isArray(metadataManifest.cells)) return state;

  const activeIds = new Set((state.manifest?.cells || []).map(cell => cell.sync_id));
  const rawIds = notebook.getCells()
    .map(cell => rawCellMetadata(cell).tex_notebook?.sync_id || null)
    .filter(Boolean);
  const unknownRawIds = rawIds.filter(id => !activeIds.has(id));
  if (!unknownRawIds.length) return state;

  const metadataIds = new Set(metadataManifest.cells.map(cell => cell.sync_id));
  if (!unknownRawIds.every(id => metadataIds.has(id))) return state;

  // The notebook was most likely regenerated or reloaded while this extension
  // still held an older session/workspaceState manifest. The current notebook
  // metadata is authoritative for the cell identities in that situation.
  const refreshed = makeSessionState(metadataManifest, notebook);
  sessionStates.set(notebook.uri.toString(), refreshed);
  await context.workspaceState.update(stateKey(notebook), { manifest: metadataManifest });
  return refreshed;
}

function liveCells(notebook, state) {
  return notebook.getCells().map(cell => {
    const cachedId = state?.cellIds?.get(cell) || null;
    const rawId = rawCellMetadata(cell).tex_notebook?.sync_id || null;
    return {
      kind: cellKind(cell),
      source: cell.document.getText(),
      sync_id: cachedId || rawId,
    };
  });
}

async function resolveSourceUri(notebook, manifest) {
  const sourceFile = manifest.source_file;
  if (!sourceFile || typeof sourceFile !== 'string') throw new SyncError('Notebook metadata does not contain source_file.');
  const sourceParts = sourceFile.replace(/\\/g, '/').split('/');
  if (sourceParts.some(part => part.startsWith('xsim-files-'))) {
    throw new SyncError(
      'Notebook provenance points to an XSIM auxiliary file. Patch exercise-book.sty with ' +
      'patch_tex_notebook_integrations.py and regenerate the notebook before syncing; ' +
      'the extension will never edit an XSIM replay file.'
    );
  }

  const candidates = [];
  const addIfFile = p => {
    try {
      if (fs.statSync(p).isFile()) candidates.push(path.resolve(p));
    } catch (_) { /* ignore */ }
  };

  if (path.isAbsolute(sourceFile)) addIfFile(sourceFile);

  for (const folder of vscode.workspace.workspaceFolders || []) {
    addIfFile(path.join(folder.uri.fsPath, sourceFile));
  }

  let dir = path.dirname(notebook.uri.fsPath);
  for (let depth = 0; depth < 8; ++depth) {
    addIfFile(path.join(dir, sourceFile));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const unique = [...new Set(candidates)];
  if (unique.length === 1) return vscode.Uri.file(unique[0]);
  if (unique.length > 1) throw new SyncError(`More than one source file matches ${sourceFile}. Open the project in a narrower VS Code workspace.`);

  const basename = path.basename(sourceFile);
  const found = await vscode.workspace.findFiles(`**/${basename}`, '**/{.git,node_modules}/**', 50);
  const normalizedSuffix = sourceFile.replace(/\\/g, '/');
  const filtered = found.filter(uri => uri.fsPath.replace(/\\/g, '/').endsWith(normalizedSuffix));
  const use = filtered.length ? filtered : found;
  if (use.length === 1) return use[0];
  if (!use.length) throw new SyncError(`Cannot find TeX source ${sourceFile} in the current workspace.`);
  throw new SyncError(`Several files named ${basename} exist; cannot select the TeX source safely.`);
}

async function warnIfProductionNotebookHasTexSyncCompanion(notebook) {
  if (notebook.isUntitled || notebook.uri.scheme !== 'file') return;
  const filePath = notebookPath(notebook);
  const companionPath = texSyncCompanionPath(filePath);
  if (!companionPath) return;

  const companionUri = vscode.Uri.file(companionPath);
  try {
    const stat = await vscode.workspace.fs.stat(companionUri);
    if ((stat.type & vscode.FileType.File) === 0) return;
  } catch (_) {
    return;
  }

  const openSync = 'Open _texsync notebook';
  const keepProduction = 'Keep production notebook';
  const choice = await vscode.window.showWarningMessage(
    `TeX Notebook Sync: ${path.basename(filePath)} has the companion ` +
      `${path.basename(companionPath)}. Are you sure you want to open the production notebook instead?`,
    { modal: true },
    openSync,
    keepProduction,
  );
  if (choice === openSync) {
    const productionUri = notebook.uri.toString();
    const productionTabs = vscode.window.tabGroups.all
      .flatMap(group => group.tabs)
      .filter(tab =>
        tab.input instanceof vscode.TabInputNotebook &&
        tab.input.uri.toString() === productionUri
      );

    const syncNotebook = await vscode.workspace.openNotebookDocument(companionUri);
    await vscode.window.showNotebookDocument(syncNotebook, { preview: false });

    if (productionTabs.length) {
      await vscode.window.tabGroups.close(productionTabs, true);
    }
  }
}

function offsetPosition(document, offset) {
  return document.positionAt(offset);
}

async function persistSessionState(context, notebook, state, result) {
  state.manifest = result.manifest;
  state.cellIds = new WeakMap();
  notebook.getCells().forEach((cell, index) => {
    const syncId = result.cellSyncIds[index];
    if (syncId) state.cellIds.set(cell, syncId);
  });
  await context.workspaceState.update(stateKey(notebook), { manifest: result.manifest });
}

async function syncNotebookToLatexOnSave(context, notebook) {
  if (notebook.isUntitled || !isTexSyncNotebookPath(notebookPath(notebook))) return;

  let state = initializeNotebookState(context, notebook);
  if (!state || !state.manifest) {
    throw new SyncError(
      `This ${TEXSYNC_NOTEBOOK_SUFFIX} notebook has no usable tex_notebook sync state. ` +
      'Regenerate it with the sync-enabled tex-notebook.sty.'
    );
  }

  state = await refreshStateFromNotebookMetadataIfNeeded(context, notebook, state);

  const sourceUri = await resolveSourceUri(notebook, state.manifest);
  const sourceDoc = await vscode.workspace.openTextDocument(sourceUri);
  if (sourceDoc.isDirty) {
    throw new SyncError('The TeX source has unsaved changes. Save it and regenerate the notebook before syncing back.');
  }

  const oldText = sourceDoc.getText();
  const result = syncNotebookToTex(oldText, state.manifest, liveCells(notebook, state));
  const replacement = minimalReplacement(oldText, result.newText);

  if (replacement) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      sourceUri,
      new vscode.Range(
        offsetPosition(sourceDoc, replacement.start),
        offsetPosition(sourceDoc, replacement.oldEnd),
      ),
      replacement.text,
    );
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) throw new SyncError('VS Code could not apply the LaTeX synchronization edit.');

    const sourceSaved = await sourceDoc.save();
    if (!sourceSaved && sourceDoc.isDirty) {
      throw new SyncError('LaTeX was updated in the editor but could not be saved.');
    }
  }

  // Do not write synchronization metadata back to the notebook. This keeps the
  // extension independent of notebook metadata-cleaning extensions and avoids
  // recursively saving the notebook from its own save hook. The fresh manifest
  // and cell identities are kept in extension state instead.
  await persistSessionState(context, notebook, state, result);
}

async function saveGuard(context, notebook) {
  try {
    await syncNotebookToLatexOnSave(context, notebook);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`TeX Notebook Sync: ${message}`);
  }
}

function activate(context) {
  // Initialize already-open notebooks (for example when activation is caused by
  // opening the first jupyter-notebook document).
  for (const notebook of vscode.workspace.notebookDocuments) {
    initializeNotebookState(context, notebook);
    void warnIfProductionNotebookHasTexSyncCompanion(notebook);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenNotebookDocument(notebook => {
      initializeNotebookState(context, notebook);
      void warnIfProductionNotebookHasTexSyncCompanion(notebook);
    }),
    vscode.workspace.onDidCloseNotebookDocument(notebook => {
      sessionStates.delete(notebook.uri.toString());
    }),
    vscode.workspace.onWillSaveNotebookDocument(event => {
      if (!isTexSyncNotebookPath(notebookPath(event.notebook))) return;
      event.waitUntil(saveGuard(context, event.notebook));
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
