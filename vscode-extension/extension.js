'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
  SyncError,
  syncNotebookToTex,
  minimalReplacement,
  buildConflictPatch,
  isTexSyncNotebookPath,
  texSyncCompanionPath,
  conflictPatchPath,
  TEXSYNC_NOTEBOOK_SUFFIX,
} = require('./syncCore');

const sessionStates = new Map();
const syncQueues = new Map();

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

function encodeSourceSnapshot(text) {
  if (typeof text !== 'string') return null;
  return zlib.gzipSync(Buffer.from(text, 'utf8')).toString('base64');
}

function decodeSourceSnapshot(encoded) {
  if (typeof encoded !== 'string' || !encoded) return null;
  try {
    return zlib.gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');
  } catch (_) {
    return null;
  }
}

function manifestsShareIdentity(a, b) {
  if (!a || !b || !Array.isArray(a.cells) || !Array.isArray(b.cells)) return false;
  if (a.source_file !== b.source_file || a.cells.length !== b.cells.length) return false;
  return a.cells.every((cell, index) => {
    const other = b.cells[index];
    return other && cell.sync_id === other.sync_id && cell.cell_type === other.cell_type;
  });
}

function makeSessionState(manifest, notebook, sourceText = null) {
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
  return { manifest, cellIds, sourceText };
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
  const persistedSourceText = manifestsShareIdentity(manifest, persistedManifest)
    ? decodeSourceSnapshot(persisted?.source_snapshot_gzip_base64)
    : null;
  const state = makeSessionState(manifest, notebook, persistedSourceText);
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
  const refreshed = makeSessionState(metadataManifest, notebook, null);
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

async function persistSessionState(context, notebook, state, result, sourceText) {
  state.manifest = result.manifest;
  state.sourceText = sourceText;
  state.cellIds = new WeakMap();
  notebook.getCells().forEach((cell, index) => {
    const syncId = result.cellSyncIds[index];
    if (syncId) state.cellIds.set(cell, syncId);
  });
  await context.workspaceState.update(stateKey(notebook), {
    manifest: result.manifest,
    source_snapshot_gzip_base64: encodeSourceSnapshot(sourceText),
  });
}


async function openConflictPatch(uri) {
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
}

async function writeConflictPatch(notebook, sourceUri, state, currentText, live, reason) {
  if (typeof state.sourceText !== 'string') return null;

  let desired;
  try {
    desired = syncNotebookToTex(state.sourceText, state.manifest, live);
  } catch (_) {
    // If the edited notebook is not valid even against the last known-good TeX
    // snapshot, this is not merely a source-divergence conflict. Let the normal
    // synchronization error explain the problem instead.
    return null;
  }

  const report = buildConflictPatch({
    baseText: state.sourceText,
    currentText,
    desiredText: desired.newText,
    sourcePath: state.manifest.source_file || path.basename(sourceUri.fsPath),
    notebookPath: path.basename(notebookPath(notebook)),
    reason,
  });
  if (!report) return null;

  const outputPath = conflictPatchPath(notebookPath(notebook));
  if (!outputPath) return null;
  const outputUri = vscode.Uri.file(outputPath);
  await vscode.workspace.fs.writeFile(outputUri, Buffer.from(report, 'utf8'));
  return outputUri;
}

async function reportSourceConflict(notebook, sourceUri, state, currentText, live, reason) {
  let patchUri = null;
  try {
    patchUri = await writeConflictPatch(notebook, sourceUri, state, currentText, live, reason);
  } catch (patchError) {
    const detail = patchError instanceof Error ? patchError.message : String(patchError);
    vscode.window.showErrorMessage(
      `TeX Notebook Sync: The notebook was saved and the TeX source was left unchanged, ` +
      `but the conflict patch could not be written: ${detail}`
    );
    return;
  }

  if (!patchUri) {
    vscode.window.showWarningMessage(
      `TeX Notebook Sync: The notebook was saved, but the TeX source was left unchanged: ${reason} ` +
      'No last synchronized full-source snapshot is available to build a conflict patch yet.'
    );
    return;
  }

  const openPatch = 'Open conflict patch';
  const choice = await vscode.window.showWarningMessage(
    `TeX Notebook Sync: The notebook was saved, but the TeX source was left unchanged because it diverged ` +
      `from the synchronization snapshot. A review patch was written to ${path.basename(patchUri.fsPath)}.`,
    openPatch,
  );
  if (choice === openPatch) await openConflictPatch(patchUri);
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
  const oldText = sourceDoc.getText();
  const live = liveCells(notebook, state);

  if (sourceDoc.isDirty) {
    await reportSourceConflict(
      notebook, sourceUri, state, oldText, live,
      'The TeX source has unsaved changes in the editor.'
    );
    return;
  }

  let result;
  try {
    result = syncNotebookToTex(oldText, state.manifest, live);
  } catch (err) {
    if (err instanceof SyncError && typeof state.sourceText === 'string') {
      let validAgainstSnapshot = false;
      try {
        syncNotebookToTex(state.sourceText, state.manifest, live);
        validAgainstSnapshot = true;
      } catch (_) {
        validAgainstSnapshot = false;
      }
      if (validAgainstSnapshot) {
        await reportSourceConflict(notebook, sourceUri, state, oldText, live, err.message);
        return;
      }
    }
    throw err;
  }
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
  await persistSessionState(context, notebook, state, result, result.newText);
}


async function saveGuard(context, notebook) {
  try {
    await syncNotebookToLatexOnSave(context, notebook);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(
      `TeX Notebook Sync: The notebook was saved, but TeX synchronization failed: ${message}`
    );
  }
}

function enqueueSyncAfterSave(context, notebook) {
  const key = notebook.uri.toString();
  const previous = syncQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => saveGuard(context, notebook))
    .finally(() => {
      if (syncQueues.get(key) === next) syncQueues.delete(key);
    });
  syncQueues.set(key, next);
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
    vscode.workspace.onDidSaveNotebookDocument(notebook => {
      if (!isTexSyncNotebookPath(notebookPath(notebook))) return;
      enqueueSyncAfterSave(context, notebook);
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
