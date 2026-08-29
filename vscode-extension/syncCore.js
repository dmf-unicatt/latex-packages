'use strict';

const crypto = require('crypto');

const TEXSYNC_NOTEBOOK_SUFFIX = '_texsync.ipynb';

function isTexSyncNotebookPath(filePath) {
  return typeof filePath === 'string' && filePath.endsWith(TEXSYNC_NOTEBOOK_SUFFIX);
}

function texSyncCompanionPath(filePath) {
  if (typeof filePath !== 'string' || isTexSyncNotebookPath(filePath) || !filePath.endsWith('.ipynb')) {
    return null;
  }
  return filePath.slice(0, -'.ipynb'.length) + TEXSYNC_NOTEBOOK_SUFFIX;
}

class SyncError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SyncError';
  }
}

function cellKindFromEnv(env) {
  return env === 'pycell' ? 'code' : 'markdown';
}

function envFromCellKind(kind) {
  if (kind === 'code') return 'pycell';
  if (kind === 'markdown') return 'mdcell';
  throw new SyncError(`Unsupported notebook cell type: ${kind}`);
}

function detectNewline(text) {
  const i = text.indexOf('\r\n');
  return i >= 0 ? '\r\n' : '\n';
}

function lineNumberAt(text, offset) {
  let n = 1;
  for (let i = 0; i < offset; ++i) {
    if (text.charCodeAt(i) === 10) n += 1;
  }
  return n;
}

function isEscapedAt(text, index) {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; --i) backslashes += 1;
  return backslashes % 2 === 1;
}

function isInTexComment(text, index) {
  const lineStart = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  for (let i = lineStart; i < index; ++i) {
    if (text[i] === '%' && !isEscapedAt(text, i)) return true;
  }
  return false;
}

function findUncommentedToken(text, token, from) {
  let pos = from;
  while ((pos = text.indexOf(token, pos)) >= 0) {
    if (!isInTexComment(text, pos)) return pos;
    pos += token.length;
  }
  return -1;
}

const OPAQUE_ENVIRONMENTS = new Set(['comment', 'verbatim', 'Verbatim', 'lstlisting', 'minted']);

function findOpaqueRanges(text) {
  const ranges = [];
  const beginRe = /\\begin\{(comment|verbatim|Verbatim|lstlisting|minted)\}/g;
  let match;
  while ((match = beginRe.exec(text)) !== null) {
    if (isInTexComment(text, match.index)) continue;
    const name = match[1];
    const endToken = `\\end{${name}}`;
    const endStart = findUncommentedToken(text, endToken, beginRe.lastIndex);
    if (endStart < 0) continue;
    const end = endStart + endToken.length;
    ranges.push([match.index, end]);
    beginRe.lastIndex = end;
  }
  return ranges;
}

function offsetInRanges(offset, ranges) {
  for (const [start, end] of ranges) {
    if (offset < start) return false;
    if (offset >= start && offset < end) return true;
  }
  return false;
}

function skipTrivia(text, pos) {
  let i = pos;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '%' && !isEscapedAt(text, i)) {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    break;
  }
  return i;
}

function parseBalancedBraces(text, openPos) {
  if (text[openPos] !== '{') return null;
  let depth = 0;
  for (let i = openPos; i < text.length; ++i) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return { start: openPos, end: i + 1, content: text.slice(openPos + 1, i) };
      }
    }
  }
  return null;
}

function parseExpectedOutputAt(text, pos) {
  const begin = '\\begin{pyexpectedoutput}';
  if (!text.startsWith(begin, pos)) return null;
  const bodyStart = pos + begin.length;
  const endToken = '\\end{pyexpectedoutput}';
  const endStart = findUncommentedToken(text, endToken, bodyStart);
  if (endStart < 0) throw new SyncError('Unterminated pyexpectedoutput environment in TeX source.');
  return {
    kind: 'output',
    start: pos,
    end: endStart + endToken.length,
    bodyStart,
    bodyEnd: endStart,
    body: text.slice(bodyStart, endStart),
  };
}

function parseExpectedFigureAt(text, pos) {
  const command = '\\pyexpectedfigure';
  if (!text.startsWith(command, pos)) return null;
  let p = skipTrivia(text, pos + command.length);
  const arg = parseBalancedBraces(text, p);
  if (!arg) throw new SyncError('Malformed \\pyexpectedfigure command in TeX source.');
  return {
    kind: 'figure',
    start: pos,
    end: arg.end,
    argument: arg.content,
  };
}

function parseCells(text) {
  const beginRe = /\\begin\{(mdcell|pycell)\}(?:\[([^\]]*)\])?/g;
  const cells = [];
  const opaqueRanges = findOpaqueRanges(text);
  let match;
  while ((match = beginRe.exec(text)) !== null) {
    if (isInTexComment(text, match.index) || offsetInRanges(match.index, opaqueRanges)) continue;
    const env = match[1];
    const start = match.index;
    const beginEnd = beginRe.lastIndex;
    const endToken = `\\end{${env}}`;
    const endStart = findUncommentedToken(text, endToken, beginEnd);
    if (endStart < 0) throw new SyncError(`Unterminated ${env} environment in TeX source.`);
    const endEnd = endStart + endToken.length;
    const cell = {
      env,
      kind: cellKindFromEnv(env),
      options: match[2] === undefined ? null : match[2],
      start,
      beginEnd,
      bodyStart: beginEnd,
      bodyEnd: endStart,
      endStart,
      endEnd,
      body: text.slice(beginEnd, endStart),
      trailers: [],
      bundleEnd: endEnd,
      parent: null,
    };

    if (env === 'pycell') {
      let p = endEnd;
      const seen = new Set();
      while (true) {
        const q = skipTrivia(text, p);
        let trailer = null;
        if (!seen.has('output')) trailer = parseExpectedOutputAt(text, q);
        if (!trailer && !seen.has('figure')) trailer = parseExpectedFigureAt(text, q);
        if (!trailer) break;
        seen.add(trailer.kind);
        cell.trailers.push(trailer);
        cell.bundleEnd = trailer.end;
        p = trailer.end;
      }
    }

    cells.push(cell);
    beginRe.lastIndex = cell.bundleEnd;
  }
  const environments = assignParents(text, cells);
  Object.defineProperty(cells, 'environments', { value: environments, enumerable: false });
  return cells;
}

function assignParents(text, cells) {
  const skipRanges = [...cells.map(c => [c.start, c.bundleEnd]), ...findOpaqueRanges(text)]
    .sort((a, b) => a[0] - b[0]);
  let skipIndex = 0;
  const tokenRe = /\\(begin|end)\{([^}]+)\}/g;
  const stack = [];
  const parentObjects = [];
  let cellIndex = 0;
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    if (isInTexComment(text, m.index)) continue;
    while (cellIndex < cells.length && cells[cellIndex].start < m.index) {
      const top = [...stack].reverse().find(x => x.name !== 'document') || null;
      cells[cellIndex].parent = top;
      cellIndex += 1;
    }

    while (skipIndex < skipRanges.length && skipRanges[skipIndex][1] <= m.index) skipIndex += 1;
    if (skipIndex < skipRanges.length) {
      const [s, e] = skipRanges[skipIndex];
      if (m.index >= s && m.index < e) {
        tokenRe.lastIndex = e;
        continue;
      }
    }

    const action = m[1];
    const name = m[2];
    if (action === 'begin') {
      const obj = {
        name,
        beginStart: m.index,
        beginEnd: tokenRe.lastIndex,
        endStart: null,
        endEnd: null,
        parent: stack.length ? stack[stack.length - 1] : null,
      };
      stack.push(obj);
      parentObjects.push(obj);
    } else {
      let idx = stack.length - 1;
      while (idx >= 0 && stack[idx].name !== name) idx -= 1;
      if (idx >= 0) {
        const obj = stack[idx];
        obj.endStart = m.index;
        obj.endEnd = tokenRe.lastIndex;
        stack.splice(idx, 1);
      }
    }
  }
  while (cellIndex < cells.length) {
    const top = [...stack].reverse().find(x => x.name !== 'document') || null;
    cells[cellIndex].parent = top;
    cellIndex += 1;
  }
  return parentObjects;
}

function findAncestorEnvironment(block, name) {
  let env = block ? block.parent : null;
  while (env) {
    if (env.name === name) return env;
    env = env.parent;
  }
  return null;
}

function environmentContainsBlock(env, block) {
  if (!env || !block || env.endStart === null) return false;
  return env.beginStart < block.start && block.bundleEnd < env.endEnd;
}

function chooseEnvironmentByLineHint(texText, environments, name, lineHint) {
  const candidates = environments.filter(env => env.name === name && env.endStart !== null);
  if (!candidates.length) return null;
  const hint = Number(lineHint || 0);
  if (hint <= 0) return candidates.length === 1 ? candidates[0] : null;
  const ranked = candidates
    .map(env => ({ env, distance: Math.abs(lineNumberAt(texText, env.beginStart) - hint) }))
    .sort((a, b) => a.distance - b.distance);
  if (ranked.length === 1 || ranked[0].distance < ranked[1].distance) return ranked[0].env;
  return null;
}

function chooseEnvironmentByOccurrence(environments, name, occurrence) {
  const n = Number(occurrence || 0);
  if (!Number.isInteger(n) || n <= 0) return null;
  const candidates = environments
    .filter(env => env.name === name && env.endStart !== null)
    .sort((a, b) => a.beginStart - b.beginStart);
  return candidates[n - 1] || null;
}

function newlineVariants(raw) {
  const out = [{ value: raw, prefix: '', suffix: '' }];
  const prefixes = raw.startsWith('\r\n') ? ['\r\n'] : raw.startsWith('\n') ? ['\n'] : [];
  const suffixes = raw.endsWith('\r\n') ? ['\r\n'] : raw.endsWith('\n') ? ['\n'] : [];
  for (const pre of prefixes) out.push({ value: raw.slice(pre.length), prefix: pre, suffix: '' });
  for (const suf of suffixes) out.push({ value: raw.slice(0, -suf.length), prefix: '', suffix: suf });
  for (const pre of prefixes) {
    for (const suf of suffixes) {
      if (raw.length >= pre.length + suf.length) {
        out.push({ value: raw.slice(pre.length, raw.length - suf.length), prefix: pre, suffix: suf });
      }
    }
  }
  return out;
}

function matchBody(raw, expected) {
  for (const variant of newlineVariants(raw)) {
    if (variant.value === expected) return variant;
  }
  return null;
}

function trailerMatches(cell, manifestCell) {
  const out = cell.trailers.find(t => t.kind === 'output');
  const fig = cell.trailers.find(t => t.kind === 'figure');
  const expectedOutput = manifestCell.expected_output ?? null;
  const expectedFigure = manifestCell.expected_figure ?? null;
  if ((out ? true : false) !== (expectedOutput !== null)) return false;
  if ((fig ? true : false) !== (expectedFigure !== null)) return false;
  if (out && !matchBody(out.body, expectedOutput)) return false;
  if (fig && fig.argument !== expectedFigure) return false;
  return true;
}

function cellMatchesManifest(cell, manifestCell) {
  if (cell.kind !== manifestCell.cell_type) return false;
  if (!matchBody(cell.body, manifestCell.original_source)) return false;
  if (!trailerMatches(cell, manifestCell)) return false;
  return true;
}

function isTexBackedManifestCell(cell) {
  return cell.tex_backed !== false;
}

function isReadOnlyManifestCell(cell) {
  return cell.read_only === true || cell.tex_backed === false;
}

function locateManifestWindow(texText, manifestRoot) {
  const cells = parseCells(texText);
  const environments = cells.environments || [];
  const manifestAll = manifestRoot.cells || [];
  const manifest = manifestAll.filter(isTexBackedManifestCell);

  // A notebook may contain only generated/read-only virtual cells. In that case
  // there is intentionally no mdcell/pycell source window to match; callers use
  // the virtual cell's owner-environment anchor instead.
  if (!manifest.length) {
    return { cells, environments, start: null, window: [], manifestCells: [] };
  }
  if (cells.length < manifest.length) {
    throw new SyncError('The TeX source no longer contains all TeX-backed cells from the notebook snapshot. Regenerate the notebook first.');
  }

  const candidates = [];
  for (let start = 0; start + manifest.length <= cells.length; ++start) {
    let ok = true;
    for (let j = 0; j < manifest.length; ++j) {
      if (!cellMatchesManifest(cells[start + j], manifest[j])) {
        ok = false;
        break;
      }
    }
    if (ok) candidates.push(start);
  }
  if (!candidates.length) {
    throw new SyncError('The TeX source has changed since this notebook was generated (cell body, order, or pyexpected* trailer differs). Regenerate the notebook before syncing back.');
  }
  if (candidates.length === 1) {
    return {
      cells,
      environments,
      start: candidates[0],
      window: cells.slice(candidates[0], candidates[0] + manifest.length),
      manifestCells: manifest,
    };
  }

  const hint = Number(manifest[0].source_line_hint || 0);
  if (hint > 0) {
    candidates.sort((a, b) => {
      const da = Math.abs(lineNumberAt(texText, cells[a].start) - hint);
      const db = Math.abs(lineNumberAt(texText, cells[b].start) - hint);
      return da - db;
    });
    const best = candidates[0];
    const bestDistance = Math.abs(lineNumberAt(texText, cells[best].start) - hint);
    const secondDistance = candidates.length > 1
      ? Math.abs(lineNumberAt(texText, cells[candidates[1]].start) - hint)
      : Infinity;
    if (bestDistance < secondDistance) {
      return {
        cells,
        environments,
        start: best,
        window: cells.slice(best, best + manifest.length),
        manifestCells: manifest,
      };
    }
  }
  throw new SyncError('The notebook TeX-backed cell sequence occurs more than once in the TeX source and cannot be disambiguated safely.');
}

function resolveVirtualOwner(texText, entry, manifestIndex, oldManifest, oldById, environments) {
  const manifest = entry.manifest;
  const ownerName = manifest.owner_environment;
  if (!ownerName) {
    throw new SyncError('A generated read-only notebook cell has no owner_environment metadata. Regenerate the notebook with the updated package integration.');
  }

  // An absolute owner occurrence is stable under cell-body edits and repeated
  // sync operations because the extension never creates/deletes owner environments.
  const byOccurrence = chooseEnvironmentByOccurrence(
    environments,
    ownerName,
    manifest.owner_occurrence,
  );
  if (byOccurrence) return byOccurrence;

  // Fall back to the source-line owner hint. This is essential for older sync
  // notebooks and for integrations that cannot compute an owner occurrence.
  const byHint = chooseEnvironmentByLineHint(
    texText,
    environments,
    ownerName,
    manifest.owner_line_hint || manifest.source_line_hint,
  );
  if (byHint) return byHint;

  // Fall back to neighboring TeX-backed cells when the line hint is unavailable
  // or ambiguous. A generated heading at owner_position="begin" prefers forward.
  const preferForward = manifest.owner_position === 'begin';
  const directions = preferForward ? [1, -1] : [-1, 1];
  for (const direction of directions) {
    for (let i = manifestIndex + direction; i >= 0 && i < oldManifest.length; i += direction) {
      const neighbor = oldManifest[i];
      if (!isTexBackedManifestCell(neighbor)) continue;
      const neighborEntry = oldById.get(neighbor.sync_id);
      if (!neighborEntry || !neighborEntry.block) continue;
      const owner = findAncestorEnvironment(neighborEntry.block, ownerName);
      if (owner) return owner;
      // The nearest TeX-backed neighbor is outside the requested owner; do not
      // skip across a different structural region looking for a farther match.
      break;
    }
  }

  throw new SyncError(`Cannot safely locate the LaTeX owner environment ${ownerName} for a generated read-only notebook cell.`);
}

function scoreContext(base, current, baseStart, baseEnd, currentStart, currentEnd, width = 32) {
  const beforeBase = base.slice(Math.max(0, baseStart - width), baseStart);
  const afterBase = base.slice(baseEnd, Math.min(base.length, baseEnd + width));
  const beforeCur = current.slice(Math.max(0, currentStart - width), currentStart);
  const afterCur = current.slice(currentEnd, Math.min(current.length, currentEnd + width));
  let score = 0;
  const n1 = Math.min(beforeBase.length, beforeCur.length);
  for (let k = 1; k <= n1; ++k) {
    if (beforeBase[beforeBase.length - k] === beforeCur[beforeCur.length - k]) score += 1;
    else break;
  }
  const n2 = Math.min(afterBase.length, afterCur.length);
  for (let k = 0; k < n2; ++k) {
    if (afterBase[k] === afterCur[k]) score += 1;
    else break;
  }
  return score;
}

function restoreRefs(manifestCell, currentSource) {
  const refs = Array.isArray(manifestCell.ref_replacements) ? manifestCell.ref_replacements : [];
  if (!refs.length) return { texSource: currentSource, refReplacements: [] };
  const base = manifestCell.generated_source;
  const chosen = [];
  const occupied = [];

  for (const ref of refs) {
    const rendered = String(ref.rendered);
    const occurrences = [];
    let p = 0;
    while (rendered.length && (p = currentSource.indexOf(rendered, p)) >= 0) {
      const e = p + rendered.length;
      if (!occupied.some(([a, b]) => p < b && e > a)) {
        occurrences.push({
          start: p,
          end: e,
          score: scoreContext(base, currentSource, Number(ref.generated_start), Number(ref.generated_end), p, e),
        });
      }
      p = e || p + 1;
    }
    if (!occurrences.length) {
      // The rendered reference was deleted/rewritten by the user. Do not resurrect it.
      continue;
    }
    occurrences.sort((a, b) => b.score - a.score || Math.abs(a.start - Number(ref.generated_start)) - Math.abs(b.start - Number(ref.generated_start)));
    if (occurrences.length > 1 && occurrences[0].score === occurrences[1].score && occurrences[0].score === 0) {
      throw new SyncError(`Cannot safely identify rendered reference ${JSON.stringify(rendered)} after notebook edits.`);
    }
    const best = occurrences[0];
    occupied.push([best.start, best.end]);
    chosen.push({
      start: best.start,
      end: best.end,
      tex: ref.tex,
      rendered,
    });
  }

  let texSource = currentSource;
  chosen.sort((a, b) => b.start - a.start);
  for (const item of chosen) {
    texSource = texSource.slice(0, item.start) + item.tex + texSource.slice(item.end);
  }

  const newRefs = chosen
    .sort((a, b) => a.start - b.start)
    .map(item => ({
      tex: item.tex,
      rendered: item.rendered,
      generated_start: item.start,
      generated_end: item.end,
    }));
  return { texSource, refReplacements: newRefs };
}

function makeSyncId(sourceFile, index, kind, source) {
  const nonce = crypto.randomBytes(8).toString('hex');
  return 'texnb-' + crypto.createHash('sha256').update(`${sourceFile}\0${index}\0${kind}\0${source}\0${nonce}`).digest('hex').slice(0, 24);
}

function wrapNewCell(kind, source, newline) {
  const env = envFromCellKind(kind);
  let body = source;
  // Keep notebook contents literal; only add boundary newlines needed by the TeX environment.
  return `\\begin{${env}}${newline}${body}${body.endsWith(newline) || body.length === 0 ? '' : newline}\\end{${env}}`;
}

function applyOperations(text, operations) {
  const ops = operations.slice().sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  let lastStart = Infinity;
  for (const op of ops) {
    if (op.start < 0 || op.end < op.start || op.end > text.length) throw new SyncError('Internal sync edit range is invalid.');
    if (op.end > lastStart && op.start !== lastStart) throw new SyncError('Internal sync edits overlap.');
    out = out.slice(0, op.start) + op.text + out.slice(op.end);
    lastStart = op.start;
  }
  return out;
}

function replaceBodyInRawBundle(texText, block, texBody) {
  const match = matchBody(block.body, block._manifest.original_source);
  if (!match) throw new SyncError('Internal error: source body no longer matches manifest.');
  const replacementBody = match.prefix + texBody + match.suffix;
  const raw = texText.slice(block.start, block.bundleEnd);
  const relStart = block.bodyStart - block.start;
  const relEnd = block.bodyEnd - block.start;
  return raw.slice(0, relStart) + replacementBody + raw.slice(relEnd);
}

function sameParent(blocks) {
  if (!blocks.length || !blocks[0].parent) return false;
  const p = blocks[0].parent;
  return blocks.every(b => b.parent && b.parent.beginStart === p.beginStart && b.parent.name === p.name);
}

function locateManifestWindowNear(texText, manifestRoot, anchorStart) {
  const cells = parseCells(texText);
  const manifest = (manifestRoot.cells || []).filter(isTexBackedManifestCell);
  if (!manifest.length) return [];

  const candidates = [];
  for (let start = 0; start + manifest.length <= cells.length; ++start) {
    let ok = true;
    for (let j = 0; j < manifest.length; ++j) {
      if (!cellMatchesManifest(cells[start + j], manifest[j])) {
        ok = false;
        break;
      }
    }
    if (ok) candidates.push(start);
  }
  if (!candidates.length) {
    throw new SyncError('Internal sync error while locating edited cells for whitespace normalization.');
  }
  if (candidates.length === 1 || anchorStart === null || anchorStart === undefined) {
    return cells.slice(candidates[0], candidates[0] + manifest.length);
  }
  candidates.sort((a, b) => Math.abs(cells[a].start - anchorStart) - Math.abs(cells[b].start - anchorStart));
  return cells.slice(candidates[0], candidates[0] + manifest.length);
}

function canonicalizeTouchedCellSpacing(texText, manifestRoot, touchedIds, newline, anchorStart) {
  if (!touchedIds.size) return texText;
  const manifest = (manifestRoot.cells || []).filter(isTexBackedManifestCell);
  if (!manifest.length) return texText;
  const cells = locateManifestWindowNear(texText, manifestRoot, anchorStart);
  const operations = [];

  // Normalize pyexpected* spacing only when its owning pycell was touched.
  // Pre-existing formatting of untouched pycells is deliberately preserved.
  for (let i = 0; i < cells.length; ++i) {
    const cell = cells[i];
    if (!touchedIds.has(manifest[i].sync_id) || cell.env !== 'pycell' || !cell.trailers.length) continue;
    let previousEnd = cell.endEnd;
    for (const trailer of cell.trailers) {
      const gap = texText.slice(previousEnd, trailer.start);
      if (/^\s*$/.test(gap) && gap !== newline) {
        operations.push({ start: previousEnd, end: trailer.start, text: newline });
      }
      previousEnd = trailer.end;
    }
  }

  // Normalize only boundaries touched by the current edit. This includes a
  // modified/added/moved cell and a newly-created boundary after deletion.
  // Unrelated pre-existing cell spacing is left byte-for-byte unchanged.
  for (let i = 1; i < cells.length; ++i) {
    const previousId = manifest[i - 1].sync_id;
    const currentId = manifest[i].sync_id;
    if (!touchedIds.has(previousId) && !touchedIds.has(currentId)) continue;
    const previous = cells[i - 1];
    const current = cells[i];
    const gap = texText.slice(previous.bundleEnd, current.start);
    const wanted = newline + newline;
    if (/^\s*$/.test(gap) && gap !== wanted) {
      operations.push({ start: previous.bundleEnd, end: current.start, text: wanted });
    }
  }

  return operations.length ? applyOperations(texText, operations) : texText;
}

function onlyTriviaBetween(texText, blocks) {
  for (let i = 1; i < blocks.length; ++i) {
    const gap = texText.slice(blocks[i - 1].bundleEnd, blocks[i].start);
    // Whitespace and TeX comments only.
    const withoutComments = gap.replace(/%[^\r\n]*(?:\r?\n|$)/g, '').trim();
    if (withoutComments !== '') return false;
  }
  return true;
}

function normalizeLiveCells(liveCells, manifestRoot) {
  const manifestCells = manifestRoot.cells || [];
  const byId = new Map(manifestCells.map(c => [c.sync_id, c]));
  const seenIds = new Set();
  const normalized = liveCells.map((cell, index) => {
    if (cell.kind !== 'code' && cell.kind !== 'markdown') {
      throw new SyncError(`Unsupported cell type at notebook index ${index}.`);
    }
    const syncId = cell.sync_id || null;
    if (syncId && !byId.has(syncId)) {
      const preview = cell.source.replace(/\s+/g, ' ').trim().slice(0, 80);
      const previewText = preview ? `; source starts with ${JSON.stringify(preview)}` : '';
      throw new SyncError(
        `Notebook cell ${index + 1} of ${liveCells.length} ` +
        `(1-based index among all notebook cells; type: ${cell.kind}${previewText}) ` +
        `has tex_notebook sync id ${JSON.stringify(syncId)}, which is not present in the active manifest. ` +
        'This usually means the extension is holding stale sync state; close and reopen the notebook, ' +
        'or regenerate it from TeX if the problem persists.'
      );
    }
    if (syncId) {
      if (seenIds.has(syncId)) {
        const old = byId.get(syncId);
        if (isReadOnlyManifestCell(old)) {
          throw new SyncError(`Generated read-only cell ${index + 1} was duplicated. Generated cells cannot be duplicated, deleted, moved, or edited.`);
        }
        // Copying an ordinary notebook cell often copies its metadata too. Treat
        // an additional occurrence as a genuinely new cell rather than letting
        // two live cells claim the same TeX source identity.
        return { ...cell, sync_id: null, index };
      }
      seenIds.add(syncId);
      const old = byId.get(syncId);
      if (old.cell_type !== cell.kind) {
        throw new SyncError(`Cell ${index + 1} changed type from ${old.cell_type} to ${cell.kind}. Type conversion is intentionally unsupported.`);
      }
      if (isReadOnlyManifestCell(old) && cell.source !== old.generated_source) {
        throw new SyncError(`Generated read-only cell ${index + 1} was edited. Regenerate the notebook to restore it.`);
      }
    }
    return { ...cell, sync_id: syncId, index };
  });

  const liveIds = new Set(normalized.filter(c => c.sync_id).map(c => c.sync_id));
  for (const old of manifestCells) {
    if (isReadOnlyManifestCell(old) && !liveIds.has(old.sync_id)) {
      throw new SyncError('A generated read-only notebook cell was deleted. Generated cells must remain present and unchanged. Regenerate the notebook to restore it.');
    }
  }
  return normalized;
}

function assertReadOnlyCellsDidNotCrossKnownCells(oldManifest, normalizedLive) {
  const oldIndex = new Map(oldManifest.map((m, i) => [m.sync_id, i]));
  const liveIndex = new Map();
  normalizedLive.forEach((c, i) => {
    if (c.sync_id) liveIndex.set(c.sync_id, i);
  });
  for (const virtual of oldManifest.filter(isReadOnlyManifestCell)) {
    const vLive = liveIndex.get(virtual.sync_id);
    if (vLive === undefined) continue;
    const vOld = oldIndex.get(virtual.sync_id);
    for (const other of oldManifest) {
      if (other.sync_id === virtual.sync_id || !liveIndex.has(other.sync_id)) continue;
      const oldRel = oldIndex.get(other.sync_id) < vOld;
      const liveRel = liveIndex.get(other.sync_id) < vLive;
      if (oldRel !== liveRel) {
        throw new SyncError('A generated read-only notebook cell was moved across an existing cell. Generated cells are structural anchors and cannot be moved.');
      }
    }
  }
}

function locateEmptyRegionAnchor(texText, anchor) {
  if (!anchor || typeof anchor !== 'object') return null;
  const before = typeof anchor.before_context === 'string' ? anchor.before_context : '';
  const after = typeof anchor.after_context === 'string' ? anchor.after_context : '';
  if (!before && !after) return null;
  const needle = before + after;
  const hits = [];
  let from = 0;
  while (from <= texText.length) {
    const at = texText.indexOf(needle, from);
    if (at < 0) break;
    hits.push(at + before.length);
    from = at + 1;
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const hint = Number(anchor.line_hint || 0);
    if (hint > 0) {
      const ranked = hits
        .map(pos => ({ pos, distance: Math.abs(lineNumberAt(texText, pos) - hint) }))
        .sort((a, b) => a.distance - b.distance);
      if (ranked.length === 1 || ranked[0].distance < ranked[1].distance) return ranked[0].pos;
    }
  }
  return null;
}

function makeEmptyRegionAnchor(texText, pos) {
  const width = 64;
  return {
    line_hint: lineNumberAt(texText, pos),
    before_context: texText.slice(Math.max(0, pos - width), pos),
    after_context: texText.slice(pos, Math.min(texText.length, pos + width)),
  };
}

function syncNotebookToTex(texText, manifestRoot, liveCells) {
  if (!manifestRoot || manifestRoot.schema_version !== 1 || !Array.isArray(manifestRoot.cells)) {
    throw new SyncError('Unsupported or missing tex_notebook manifest. Regenerate the notebook with the sync-enabled package.');
  }
  const normalizedLive = normalizeLiveCells(liveCells, manifestRoot);
  const oldManifest = manifestRoot.cells;
  assertReadOnlyCellsDidNotCrossKnownCells(oldManifest, normalizedLive);

  const located = locateManifestWindow(texText, manifestRoot);
  const blocks = located.window;
  const oldById = new Map();
  let texBlockIndex = 0;
  oldManifest.forEach((m, manifestIndex) => {
    let block = null;
    if (isTexBackedManifestCell(m)) {
      block = blocks[texBlockIndex++];
      if (!block) throw new SyncError('Internal sync error while mapping TeX-backed manifest cells.');
      block._manifest = m;
    }
    oldById.set(m.sync_id, { manifest: m, block, owner: null, manifestIndex });
  });

  // Resolve owners for generated/read-only virtual cells. These cells exist in
  // the notebook but intentionally have no mdcell/pycell source representation.
  for (const entry of oldById.values()) {
    if (!isTexBackedManifestCell(entry.manifest)) {
      entry.owner = resolveVirtualOwner(
        texText,
        entry,
        entry.manifestIndex,
        oldManifest,
        oldById,
        located.environments,
      );
    }
  }

  const oldTexOrder = oldManifest.filter(isTexBackedManifestCell).map(m => m.sync_id);
  const liveKnownTexOrder = normalizedLive
    .filter(c => c.sync_id && isTexBackedManifestCell(oldById.get(c.sync_id).manifest))
    .map(c => c.sync_id);
  const survivingOldTexOrder = oldTexOrder.filter(id => liveKnownTexOrder.includes(id));
  const reordered = survivingOldTexOrder.some((id, i) => liveKnownTexOrder[i] !== id);
  const newline = detectNewline(texText);

  const prepared = normalizedLive.map(cell => {
    let syncId = cell.sync_id;
    const old = syncId ? oldById.get(syncId) : null;
    let texSource = cell.source;
    let refs = [];
    if (old && isTexBackedManifestCell(old.manifest) && cell.kind === 'markdown') {
      const restored = restoreRefs(old.manifest, cell.source);
      texSource = restored.texSource;
      refs = restored.refReplacements;
    }
    if (!syncId) syncId = makeSyncId(manifestRoot.source_file || '', cell.index, cell.kind, cell.source);
    return { ...cell, sync_id: syncId, old, texSource, refReplacements: refs };
  });

  // Track only cells/boundaries affected by this sync. Existing unrelated
  // whitespace is intentionally not reformatted.
  const spacingTouchedIds = new Set();
  for (const cell of prepared) {
    if (!cell.old) {
      spacingTouchedIds.add(cell.sync_id);
    } else if (isTexBackedManifestCell(cell.old.manifest) && cell.source !== cell.old.manifest.generated_source) {
      spacingTouchedIds.add(cell.sync_id);
    }
  }
  const finalTexOrder = prepared
    .filter(c => !c.old || isTexBackedManifestCell(c.old.manifest))
    .map(c => c.sync_id);
  const finalTexIndex = new Map(finalTexOrder.map((id, index) => [id, index]));
  const oldTexIndex = new Map(oldTexOrder.map((id, index) => [id, index]));
  for (const id of finalTexOrder) {
    if (!oldTexIndex.has(id)) continue;
    const oi = oldTexIndex.get(id);
    const ni = finalTexIndex.get(id);
    const oldPrevious = oi > 0 ? oldTexOrder[oi - 1] : null;
    const oldNext = oi + 1 < oldTexOrder.length ? oldTexOrder[oi + 1] : null;
    const newPrevious = ni > 0 ? finalTexOrder[ni - 1] : null;
    const newNext = ni + 1 < finalTexOrder.length ? finalTexOrder[ni + 1] : null;
    if (oldPrevious !== newPrevious || oldNext !== newNext) spacingTouchedIds.add(id);
  }
  const spacingAnchorStart = located.window.length
    ? located.window[0].start
    : locateEmptyRegionAnchor(texText, manifestRoot.empty_region_anchor);

  let newText;
  if (reordered) {
    if (prepared.some(c => !c.old)) {
      throw new SyncError('Combining reordering with newly added cells is intentionally unsupported. Sync additions first, then reorder in a separate operation.');
    }

    // Partition the original TeX-backed cells into independent pure-cell runs.
    // A run may be reordered only within one enclosing environment (or root
    // level) and only across whitespace/comments. This lets a pybeamer notebook
    // reorder cells inside one pyexercise without requiring cells from other
    // pyexercise environments to share the same parent.
    const texEntries = oldManifest
      .filter(isTexBackedManifestCell)
      .map(m => ({ id: m.sync_id, manifest: m, block: oldById.get(m.sync_id).block }));
    const runs = [];
    for (const entry of texEntries) {
      const previousRun = runs.length ? runs[runs.length - 1] : null;
      const previousEntry = previousRun && previousRun.entries.length
        ? previousRun.entries[previousRun.entries.length - 1]
        : null;
      let sameRun = false;
      if (previousEntry) {
        const sameParentObject = previousEntry.block.parent === entry.block.parent;
        const gap = texText.slice(previousEntry.block.bundleEnd, entry.block.start);
        const gapWithoutComments = gap.replace(/%[^\r\n]*(?:\r?\n|$)/g, '').trim();
        sameRun = sameParentObject && gapWithoutComments === '';
      }
      if (!sameRun) runs.push({ entries: [entry] });
      else previousRun.entries.push(entry);
    }

    const runById = new Map();
    runs.forEach((run, runIndex) => run.entries.forEach(entry => runById.set(entry.id, runIndex)));
    const liveRunIndices = liveKnownTexOrder.map(id => runById.get(id));
    for (let i = 1; i < liveRunIndices.length; ++i) {
      if (liveRunIndices[i] < liveRunIndices[i - 1]) {
        throw new SyncError('A cell was moved across a LaTeX structural boundary. Reordering is allowed only within one pure-cell enclosing region.');
      }
    }

    const liveIdSet = new Set(liveKnownTexOrder);
    const operations = [];
    runs.forEach((run, runIndex) => {
      const originalSurvivors = run.entries.map(e => e.id).filter(id => liveIdSet.has(id));
      const liveIdsInRun = liveKnownTexOrder.filter(id => runById.get(id) === runIndex);
      const runReordered = originalSurvivors.some((id, i) => liveIdsInRun[i] !== id);

      if (runReordered) {
        const preparedRun = prepared.filter(
          c => c.old && isTexBackedManifestCell(c.old.manifest) && runById.get(c.sync_id) === runIndex,
        );
        const rawBlocks = preparedRun.map(cell => replaceBodyInRawBundle(texText, cell.old.block, cell.texSource));
        const first = run.entries[0].block;
        const last = run.entries[run.entries.length - 1].block;
        operations.push({
          start: first.start,
          end: last.bundleEnd,
          text: rawBlocks.join(newline + newline),
        });
        return;
      }

      // Runs unaffected by reordering still need ordinary deletion/modification
      // handling because another run may be the one that was reordered.
      for (const entry of run.entries) {
        if (!liveIdSet.has(entry.id)) {
          operations.push({ start: entry.block.start, end: entry.block.bundleEnd, text: '' });
        }
      }
      for (const cell of prepared) {
        if (!cell.old || !isTexBackedManifestCell(cell.old.manifest)) continue;
        if (runById.get(cell.sync_id) !== runIndex) continue;
        if (cell.source === cell.old.manifest.generated_source) continue;
        const block = cell.old.block;
        const bodyMatch = matchBody(block.body, cell.old.manifest.original_source);
        if (!bodyMatch) throw new SyncError('TeX source changed since notebook generation. Regenerate before syncing.');
        operations.push({
          start: block.bodyStart,
          end: block.bodyEnd,
          text: bodyMatch.prefix + cell.texSource + bodyMatch.suffix,
        });
      }
    });
    newText = applyOperations(texText, operations);
  } else {
    const operations = [];
    const liveIds = new Set(prepared.filter(c => c.old).map(c => c.sync_id));

    // Delete missing original TeX-backed cells together with their pyexpected*
    // trailers. Generated/read-only virtual cells were already required to stay.
    for (const [id, entry] of oldById.entries()) {
      if (!isTexBackedManifestCell(entry.manifest)) continue;
      if (!liveIds.has(id)) operations.push({ start: entry.block.start, end: entry.block.bundleEnd, text: '' });
    }

    // Modify existing TeX-backed bodies only; delimiters/options/trailers remain
    // byte-for-byte unchanged. Virtual cells are immutable and have no TeX body.
    for (const cell of prepared) {
      if (!cell.old || !isTexBackedManifestCell(cell.old.manifest)) continue;
      const block = cell.old.block;
      const m = cell.old.manifest;
      if (cell.source === m.generated_source) continue;
      const bodyMatch = matchBody(block.body, m.original_source);
      if (!bodyMatch) throw new SyncError('TeX source changed since notebook generation. Regenerate before syncing.');
      operations.push({
        start: block.bodyStart,
        end: block.bodyEnd,
        text: bodyMatch.prefix + cell.texSource + bodyMatch.suffix,
      });
    }

    // Add runs of new cells. Generated/read-only cells act as structural anchors:
    // a generated heading with owner_position="begin" conceptually sits at the
    // beginning of its owner environment but has no literal TeX source cell.
    let i = 0;
    while (i < prepared.length) {
      if (prepared[i].old) {
        i += 1;
        continue;
      }
      const start = i;
      while (i < prepared.length && !prepared[i].old) i += 1;
      const run = prepared.slice(start, i);
      const next = i < prepared.length ? prepared[i] : null;
      let prev = null;
      for (let j = start - 1; j >= 0; --j) {
        if (prepared[j].old) { prev = prepared[j]; break; }
      }
      const blockText = run.map(c => wrapNewCell(c.kind, c.texSource, newline)).join(newline + newline);

      const prevVirtual = prev && prev.old && !isTexBackedManifestCell(prev.old.manifest) ? prev.old : null;
      const nextVirtual = next && next.old && !isTexBackedManifestCell(next.old.manifest) ? next.old : null;
      const prevBlock = prev && prev.old && isTexBackedManifestCell(prev.old.manifest) ? prev.old.block : null;
      const nextBlock = next && next.old && isTexBackedManifestCell(next.old.manifest) ? next.old.block : null;

      if (prevVirtual && prevVirtual.manifest.owner_position === 'begin') {
        const owner = prevVirtual.owner;
        if (!owner || owner.endStart === null) throw new SyncError('Cannot insert after a generated owner-heading cell because its owner environment could not be located.');
        // If the next surviving TeX-backed cell belongs to the same owner, place
        // the new run immediately before it. Otherwise append at the owner's end.
        const pos = nextBlock && environmentContainsBlock(owner, nextBlock)
          ? nextBlock.start
          : owner.endStart;
        operations.push({ start: pos, end: pos, text: blockText + newline + newline });
      } else if (nextBlock) {
        const nextParent = nextBlock.parent;
        const prevParent = prevBlock ? prevBlock.parent : null;
        if (nextParent || !prevParent) {
          operations.push({ start: nextBlock.start, end: nextBlock.start, text: blockText + newline + newline });
        } else {
          operations.push({ start: prevBlock.bundleEnd, end: prevBlock.bundleEnd, text: newline + newline + blockText });
        }
      } else if (nextVirtual && nextVirtual.manifest.owner_position === 'begin') {
        // A generated heading marks the beginning of its owner. If the previous
        // real cell is still inside its own enclosing environment, keep the new
        // cell in that previous environment; otherwise place it before the next
        // owner's \begin{...} boundary.
        if (prevBlock && prevBlock.parent) {
          operations.push({ start: prevBlock.bundleEnd, end: prevBlock.bundleEnd, text: newline + newline + blockText });
        } else {
          const owner = nextVirtual.owner;
          if (!owner) throw new SyncError('Cannot insert before a generated owner-heading cell because its owner environment could not be located.');
          // The generated heading is emitted by the owner environment itself and
          // therefore must remain the first notebook cell for that owner. There
          // is no TeX source position inside the owner that would reproduce a
          // notebook cell *before* the generated heading on regeneration.
          throw new SyncError('Cannot insert a new cell before a generated read-only owner heading. Insert it after the generated heading instead.');
        }
      } else if (prevBlock) {
        operations.push({ start: prevBlock.bundleEnd, end: prevBlock.bundleEnd, text: newline + newline + blockText });
      } else if (prevVirtual) {
        const owner = prevVirtual.owner;
        if (!owner || owner.endStart === null) throw new SyncError('Cannot locate the owner boundary for a generated read-only cell.');
        operations.push({ start: owner.endStart, end: owner.endStart, text: blockText + newline + newline });
      } else if (blocks.length) {
        // All original TeX-backed cells were deleted in this same sync operation.
        operations.push({ start: blocks[0].start, end: blocks[0].start, text: blockText + newline + newline });
      } else {
        const pos = locateEmptyRegionAnchor(texText, manifestRoot.empty_region_anchor);
        if (pos === null) {
          throw new SyncError('This notebook has no remaining source cells and its empty-region anchor cannot be located safely. Regenerate the notebook before adding cells.');
        }
        operations.push({ start: pos, end: pos, text: blockText + newline + newline });
      }
    }

    newText = applyOperations(texText, operations);
  }

  // Build a fresh baseline manifest corresponding exactly to the new TeX and
  // current notebook. Generated/read-only entries retain their virtual ownership;
  // new user cells are always ordinary TeX-backed mdcell/pycell entries.
  const freshCells = prepared.map((cell, index) => {
    if (cell.old && !isTexBackedManifestCell(cell.old.manifest)) {
      return {
        ...cell.old.manifest,
        source_ordinal: index,
        generated_source: cell.source,
        tex_backed: false,
        read_only: true,
      };
    }
    return {
      sync_id: cell.sync_id,
      cell_type: cell.kind,
      environment: envFromCellKind(cell.kind),
      source_ordinal: index,
      source_line_hint: 0,
      original_source: cell.texSource,
      generated_source: cell.source,
      ref_replacements: cell.refReplacements,
      expected_output: cell.old ? (cell.old.manifest.expected_output ?? null) : null,
      expected_figure: cell.old ? (cell.old.manifest.expected_figure ?? null) : null,
      tex_backed: true,
      read_only: false,
      owner_environment: null,
      owner_position: null,
      owner_line_hint: 0,
      owner_occurrence: null,
    };
  });
  const freshRoot = { ...manifestRoot, cells: freshCells };

  newText = canonicalizeTouchedCellSpacing(
    newText, freshRoot, spacingTouchedIds, newline, spacingAnchorStart,
  );

  const freshTexCells = freshCells.filter(isTexBackedManifestCell);
  if (freshTexCells.length) {
    delete freshRoot.empty_region_anchor;
    try {
      const relocalized = locateManifestWindow(newText, freshRoot);
      let j = 0;
      for (const cell of freshCells) {
        if (!isTexBackedManifestCell(cell)) continue;
        cell.source_line_hint = lineNumberAt(newText, relocalized.window[j].start);
        j += 1;
      }
    } catch (_) {
      // Line hints are only disambiguation aids. A later package regeneration refreshes them.
    }
  } else if (!freshCells.some(c => !isTexBackedManifestCell(c))) {
    // Preserve a stable insertion point even if the user deletes every cell and
    // later adds a new one before recompiling the TeX source.
    const replacement = minimalReplacement(texText, newText);
    const pos = replacement ? replacement.start : locateEmptyRegionAnchor(newText, manifestRoot.empty_region_anchor);
    if (pos !== null && pos !== undefined) freshRoot.empty_region_anchor = makeEmptyRegionAnchor(newText, pos);
  }

  const survivingOldTexCount = prepared.filter(c => c.old && isTexBackedManifestCell(c.old.manifest)).length;
  const summary = {
    modified: prepared.filter(c => c.old && isTexBackedManifestCell(c.old.manifest) && c.source !== c.old.manifest.generated_source).length,
    added: prepared.filter(c => !c.old).length,
    deleted: oldManifest.filter(isTexBackedManifestCell).length - survivingOldTexCount,
    reordered,
  };

  return {
    newText,
    manifest: freshRoot,
    cellSyncIds: prepared.map(c => c.sync_id),
    cellMetadata: freshCells.map(c => ({
      sync_id: c.sync_id,
      tex_backed: isTexBackedManifestCell(c),
      read_only: isReadOnlyManifestCell(c),
      managed_read_only: isReadOnlyManifestCell(c),
    })),
    summary,
  };
}

function minimalReplacement(oldText, newText) {
  if (oldText === newText) return null;
  let start = 0;
  const maxStart = Math.min(oldText.length, newText.length);
  while (start < maxStart && oldText[start] === newText[start]) start += 1;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return { start, oldEnd, text: newText.slice(start, newEnd) };
}

module.exports = {
  SyncError,
  parseCells,
  locateManifestWindow,
  restoreRefs,
  syncNotebookToTex,
  minimalReplacement,
  matchBody,
  isTexSyncNotebookPath,
  texSyncCompanionPath,
  TEXSYNC_NOTEBOOK_SUFFIX,
};
