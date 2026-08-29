'use strict';

const assert = require('assert');
const {
  parseCells,
  syncNotebookToTex,
  isTexSyncNotebookPath,
  texSyncCompanionPath,
  TEXSYNC_NOTEBOOK_SUFFIX,
} = require('../syncCore');

(function testTexSyncFilenamePolicy() {
  assert.strictEqual(TEXSYNC_NOTEBOOK_SUFFIX, '_texsync.ipynb');
  assert.strictEqual(isTexSyncNotebookPath('/tmp/lesson_texsync.ipynb'), true);
  assert.strictEqual(isTexSyncNotebookPath('/tmp/lesson.ipynb'), false);
  assert.strictEqual(isTexSyncNotebookPath('/tmp/lesson_texsync.IPYNB'), false);
  assert.strictEqual(isTexSyncNotebookPath('/tmp/lesson_texsync.ipynb.backup'), false);
  assert.strictEqual(texSyncCompanionPath('/tmp/lesson.ipynb'), '/tmp/lesson_texsync.ipynb');
  assert.strictEqual(texSyncCompanionPath('/tmp/lesson_texsync.ipynb'), null);
  assert.strictEqual(texSyncCompanionPath('/tmp/lesson.txt'), null);
})();

function manifestCell(id, type, original, generated = original, extra = {}) {
  return {
    sync_id: id,
    cell_type: type,
    environment: type === 'code' ? 'pycell' : 'mdcell',
    source_ordinal: 0,
    source_line_hint: 1,
    original_source: original,
    generated_source: generated,
    ref_replacements: [],
    expected_output: null,
    expected_figure: null,
    ...extra,
  };
}

(function testUnknownSyncIdErrorIdentifiesGlobalNotebookCell() {
  const tex = String.raw`\begin{mdcell}
A
\end{mdcell}`;
  const root = {
    schema_version: 1,
    source_file: 'lesson.tex',
    cells: [manifestCell('a', 'markdown', 'A')],
  };
  assert.throws(
    () => syncNotebookToTex(tex, root, [
      { kind: 'markdown', source: 'A', sync_id: 'a' },
      { kind: 'code', source: 'import dolfinx.fem\nimport numpy as np', sync_id: 'stale-id' },
    ]),
    err => {
      assert(err instanceof Error);
      assert.match(err.message, /Notebook cell 2 of 2/);
      assert.match(err.message, /1-based index among all notebook cells/);
      assert.match(err.message, /type: code/);
      assert.match(err.message, /import dolfinx\.fem/);
      assert.match(err.message, /stale-id/);
      return true;
    },
  );
})();

(function testParseExpectedTrailers() {
  const tex = String.raw`\begin{block}
\begin{pycell}
print(1)
\end{pycell}
\begin{pyexpectedoutput}
1
\end{pyexpectedoutput}
\pyexpectedfigure{expected/a.png}
\begin{mdcell}
hello
\end{mdcell}
\end{block}`;
  const cells = parseCells(tex);
  assert.strictEqual(cells.length, 2);
  assert.strictEqual(cells[0].trailers.length, 2);
  assert.strictEqual(cells[0].trailers[0].kind, 'output');
  assert.strictEqual(cells[0].trailers[1].kind, 'figure');
  assert.strictEqual(cells[0].parent.name, 'block');
  assert.strictEqual(cells[1].parent.name, 'block');
})();

(function testModifyAddDeleteAndTrailerOwnership() {
  const tex = String.raw`\begin{lesson}
\begin{mdcell}
A
\end{mdcell}

\begin{pycell}
print(1)
\end{pycell}
\begin{pyexpectedoutput}
1
\end{pyexpectedoutput}
\pyexpectedfigure{fig.png}

\begin{mdcell}
C
\end{mdcell}
\end{lesson}`;
  const root = {
    schema_version: 1,
    source_file: 'lesson.tex',
    cells: [
      manifestCell('a', 'markdown', 'A'),
      manifestCell('b', 'code', 'print(1)', 'print(1)', { expected_output: '1', expected_figure: 'fig.png' }),
      manifestCell('c', 'markdown', 'C'),
    ],
  };
  const live = [
    { kind: 'markdown', source: 'A changed', sync_id: 'a' },
    { kind: 'code', source: 'x = 2', sync_id: null },
    { kind: 'markdown', source: 'C', sync_id: 'c' },
  ];
  const out = syncNotebookToTex(tex, root, live);
  assert(out.newText.includes('A changed'));
  assert(out.newText.includes('\\begin{pycell}\nx = 2\n\\end{pycell}'));
  assert(!out.newText.includes('print(1)'));
  assert(!out.newText.includes('pyexpectedoutput'));
  assert(!out.newText.includes('pyexpectedfigure'));
  assert.strictEqual(out.manifest.cells[1].expected_output, null);
  assert.strictEqual(out.summary.added, 1);
  assert.strictEqual(out.summary.deleted, 1);
})();

(function testDeletionLeavesExactlyOneBlankLineBetweenCells() {
  const tex = String.raw`\begin{pycell}
import plotly.subplots
\end{pycell}

\begin{pycell}
jax.config.update("jax_enable_x64", True)
\end{pycell}

\begin{mdcell}[print=false]
## Homework $\gamma$.1
\end{mdcell}`;
  const root = {
    schema_version: 1,
    source_file: 'homework_gamma.tex',
    cells: [
      manifestCell('a', 'code', 'import plotly.subplots'),
      manifestCell('b', 'code', 'jax.config.update("jax_enable_x64", True)'),
      manifestCell('c', 'markdown', '## Homework $\\gamma$.1'),
    ],
  };
  const out = syncNotebookToTex(tex, root, [
    { kind: 'code', source: 'import plotly.subplots', sync_id: 'a' },
    { kind: 'markdown', source: '## Homework $\\gamma$.1', sync_id: 'c' },
  ]);
  assert.strictEqual(out.newText, String.raw`\begin{pycell}
import plotly.subplots
\end{pycell}

\begin{mdcell}[print=false]
## Homework $\gamma$.1
\end{mdcell}`);
})();

(function testInsertionUsesExactlyOneBlankLineBetweenCells() {
  const tex = String.raw`\begin{mdcell}
A
\end{mdcell}

\begin{mdcell}
B
\end{mdcell}`;
  const root = {
    schema_version: 1,
    source_file: 'a.tex',
    cells: [manifestCell('a', 'markdown', 'A'), manifestCell('b', 'markdown', 'B')],
  };
  const out = syncNotebookToTex(tex, root, [
    { kind: 'markdown', source: 'A', sync_id: 'a' },
    { kind: 'code', source: 'x = 1', sync_id: null },
    { kind: 'markdown', source: 'B', sync_id: 'b' },
  ]);
  assert.strictEqual(out.newText, String.raw`\begin{mdcell}
A
\end{mdcell}

\begin{pycell}
x = 1
\end{pycell}

\begin{mdcell}
B
\end{mdcell}`);
})();

(function testExpectedTrailersHaveNoBlankLineFromOwningPycell() {
  const tex = String.raw`\begin{pycell}
print(1)
\end{pycell}

\begin{pyexpectedoutput}
1
\end{pyexpectedoutput}

\pyexpectedfigure{fig.png}

\begin{mdcell}
B
\end{mdcell}`;
  const root = {
    schema_version: 1,
    source_file: 'a.tex',
    cells: [
      manifestCell('a', 'code', 'print(1)', 'print(1)', {
        expected_output: '1',
        expected_figure: 'fig.png',
      }),
      manifestCell('b', 'markdown', 'B'),
    ],
  };
  const out = syncNotebookToTex(tex, root, [
    { kind: 'code', source: 'print(1)  # changed', sync_id: 'a' },
    { kind: 'markdown', source: 'B', sync_id: 'b' },
  ]);
  assert.strictEqual(out.newText, String.raw`\begin{pycell}
print(1)  # changed
\end{pycell}
\begin{pyexpectedoutput}
1
\end{pyexpectedoutput}
\pyexpectedfigure{fig.png}

\begin{mdcell}
B
\end{mdcell}`);
})();

(function testUntouchedNonCanonicalCellSpacingIsPreserved() {
  const tex = String.raw`\begin{mdcell}
A
\end{mdcell}



\begin{mdcell}
B
\end{mdcell}
\begin{pycell}
print(1)
\end{pycell}

\begin{pyexpectedoutput}
1
\end{pyexpectedoutput}`;
  const root = {
    schema_version: 1,
    source_file: 'a.tex',
    cells: [
      manifestCell('a', 'markdown', 'A'),
      manifestCell('b', 'markdown', 'B'),
      manifestCell('c', 'code', 'print(1)', 'print(1)', { expected_output: '1' }),
    ],
  };
  const out = syncNotebookToTex(tex, root, [
    { kind: 'markdown', source: 'A changed', sync_id: 'a' },
    { kind: 'markdown', source: 'B', sync_id: 'b' },
    { kind: 'code', source: 'print(1)', sync_id: 'c' },
  ]);

  // A was modified, so its boundary with B is normalized to one blank line.
  assert(out.newText.includes('\\end{mdcell}\n\n\\begin{mdcell}\nB'));
  // C was untouched, so its pre-existing blank line before pyexpectedoutput
  // remains unchanged even though it violates the preferred convention.
  assert(out.newText.includes('print(1)\n\\end{pycell}\n\n\\begin{pyexpectedoutput}'));
})();

(function testReferenceRestoration() {
  const original = 'See `\\eqref{eq:a}`{=tex} for details.';
  const generated = 'See (12) for details.';
  const tex = `\\begin{mdcell}\n${original}\n\\end{mdcell}`;
  const root = {
    schema_version: 1,
    source_file: 'a.tex',
    cells: [manifestCell('m', 'markdown', original, generated, {
      ref_replacements: [{ tex: '`\\eqref{eq:a}`{=tex}', rendered: '(12)', generated_start: 4, generated_end: 8 }],
    })],
  };
  const out = syncNotebookToTex(tex, root, [{ kind: 'markdown', source: 'See (12) immediately for details.', sync_id: 'm' }]);
  assert(out.newText.includes('See `\\eqref{eq:a}`{=tex} immediately for details.'));
})();

(function testNewCellStaysInsideNextParent() {
  const tex = String.raw`\begin{first}
\begin{mdcell}
A
\end{mdcell}
\end{first}

\begin{second}
\begin{mdcell}
B
\end{mdcell}
\end{second}`;
  const root = {
    schema_version: 1,
    source_file: 'a.tex',
    cells: [manifestCell('a', 'markdown', 'A'), manifestCell('b', 'markdown', 'B')],
  };
  const out = syncNotebookToTex(tex, root, [
    { kind: 'markdown', source: 'A', sync_id: 'a' },
    { kind: 'code', source: 'new()', sync_id: null },
    { kind: 'markdown', source: 'B', sync_id: 'b' },
  ]);
  const secondBegin = out.newText.indexOf('\\begin{second}');
  const newCell = out.newText.indexOf('new()');
  const b = out.newText.indexOf('B', newCell);
  const secondEnd = out.newText.indexOf('\\end{second}');
  assert(secondBegin < newCell && newCell < b && b < secondEnd);
})();


(function testPreviousParentWinsWhenNextHasNoParent() {
  const tex = String.raw`\begin{inside}
\begin{mdcell}
A
\end{mdcell}
\end{inside}

plain latex

\begin{mdcell}
B
\end{mdcell}`;
  const root = {
    schema_version: 1,
    source_file: 'a.tex',
    cells: [manifestCell('a', 'markdown', 'A'), manifestCell('b', 'markdown', 'B')],
  };
  const out = syncNotebookToTex(tex, root, [
    { kind: 'markdown', source: 'A', sync_id: 'a' },
    { kind: 'code', source: 'new_inside()', sync_id: null },
    { kind: 'markdown', source: 'B', sync_id: 'b' },
  ]);
  const begin = out.newText.indexOf('\\begin{inside}');
  const inserted = out.newText.indexOf('new_inside()');
  const end = out.newText.indexOf('\\end{inside}');
  const plain = out.newText.indexOf('plain latex');
  assert(begin < inserted && inserted < end && end < plain);
})();


(function testReorderMovesExpectedTrailersWithOriginalCodeCell() {
  const tex = String.raw`\begin{cells}
\begin{pycell}
print(7)
\end{pycell}
\begin{pyexpectedoutput}
7
\end{pyexpectedoutput}

\begin{mdcell}
M
\end{mdcell}
\end{cells}`;
  const root = {
    schema_version: 1,
    source_file: 'a.tex',
    cells: [
      manifestCell('p', 'code', 'print(7)', 'print(7)', { expected_output: '7' }),
      manifestCell('m', 'markdown', 'M'),
    ],
  };
  const out = syncNotebookToTex(tex, root, [
    { kind: 'markdown', source: 'M', sync_id: 'm' },
    { kind: 'code', source: 'print(7)', sync_id: 'p' },
  ]);
  const m = out.newText.indexOf('M');
  const pcell = out.newText.indexOf('print(7)');
  const expected = out.newText.indexOf('pyexpectedoutput');
  assert(m < pcell && pcell < expected);
  assert.strictEqual(out.manifest.cells[1].expected_output, '7');
  assert.strictEqual(out.summary.reordered, true);
})();


(function testGeneratedExerciseHeadingAnchorsInsertionInsidePyexercise() {
  const tex = String.raw`\begin{pyexercise}{x}
\begin{mdcell}
A
\end{mdcell}
\end{pyexercise}`;
  const root = {
    schema_version: 1,
    source_file: 'lesson.tex',
    cells: [
      manifestCell('heading', 'markdown', '## Exercise 1.1', '## Exercise 1.1', {
        tex_backed: false,
        read_only: true,
        owner_environment: 'pyexercise',
        owner_position: 'begin',
        owner_line_hint: 1,
        source_line_hint: 1,
      }),
      manifestCell('a', 'markdown', 'A', 'A', { source_line_hint: 2 }),
    ],
  };
  const out = syncNotebookToTex(tex, root, [
    { kind: 'markdown', source: '## Exercise 1.1', sync_id: 'heading' },
    { kind: 'code', source: 'new_code()', sync_id: null },
    { kind: 'markdown', source: 'A', sync_id: 'a' },
  ]);
  const begin = out.newText.indexOf('\\begin{pyexercise}');
  const inserted = out.newText.indexOf('new_code()');
  const a = out.newText.indexOf('\nA\n');
  const end = out.newText.indexOf('\\end{pyexercise}');
  assert(begin < inserted && inserted < a && a < end);
  assert.strictEqual(out.manifest.cells[0].tex_backed, false);
  assert.strictEqual(out.manifest.cells[0].read_only, true);
  assert.strictEqual(out.manifest.cells[1].tex_backed, true);
})();

(function testGeneratedExerciseHeadingCannotBeEditedOrDeleted() {
  const tex = String.raw`\begin{pyexercise}{x}
\begin{mdcell}
A
\end{mdcell}
\end{pyexercise}`;
  const virtual = manifestCell('heading', 'markdown', '## Exercise 1.1', '## Exercise 1.1', {
    tex_backed: false,
    read_only: true,
    owner_environment: 'pyexercise',
    owner_position: 'begin',
    owner_line_hint: 1,
  });
  const root = { schema_version: 1, source_file: 'lesson.tex', cells: [virtual, manifestCell('a', 'markdown', 'A')] };
  assert.throws(
    () => syncNotebookToTex(tex, root, [
      { kind: 'markdown', source: '## Exercise CHANGED', sync_id: 'heading' },
      { kind: 'markdown', source: 'A', sync_id: 'a' },
    ]),
    /read-only cell.*edited/i,
  );
  assert.throws(
    () => syncNotebookToTex(tex, root, [{ kind: 'markdown', source: 'A', sync_id: 'a' }]),
    /read-only notebook cell was deleted/i,
  );
})();

(function testEmptyPyexerciseUsesOwnerLineHintNotNextExercise() {
  const tex = String.raw`\begin{pyexercise}{empty}
\end{pyexercise}

\begin{pyexercise}{nonempty}
\begin{mdcell}
B
\end{mdcell}
\end{pyexercise}`;
  const root = {
    schema_version: 1,
    source_file: 'lesson.tex',
    cells: [
      manifestCell('h1', 'markdown', '## Exercise 1.1', '## Exercise 1.1', {
        tex_backed: false, read_only: true, owner_environment: 'pyexercise', owner_position: 'begin',
        source_line_hint: 1, owner_line_hint: 1,
      }),
      manifestCell('h2', 'markdown', '## Exercise 1.2', '## Exercise 1.2', {
        tex_backed: false, read_only: true, owner_environment: 'pyexercise', owner_position: 'begin',
        source_line_hint: 4, owner_line_hint: 4,
      }),
      manifestCell('b', 'markdown', 'B', 'B', { source_line_hint: 5 }),
    ],
  };
  const out = syncNotebookToTex(tex, root, [
    { kind: 'markdown', source: '## Exercise 1.1', sync_id: 'h1' },
    { kind: 'markdown', source: 'Inserted into empty exercise', sync_id: null },
    { kind: 'markdown', source: '## Exercise 1.2', sync_id: 'h2' },
    { kind: 'markdown', source: 'B', sync_id: 'b' },
  ]);
  const firstBegin = out.newText.indexOf('\\begin{pyexercise}{empty}');
  const firstEnd = out.newText.indexOf('\\end{pyexercise}', firstBegin);
  const inserted = out.newText.indexOf('Inserted into empty exercise');
  const secondBegin = out.newText.indexOf('\\begin{pyexercise}{nonempty}');
  assert(firstBegin < inserted && inserted < firstEnd && firstEnd < secondBegin);
})();

(function testDuplicatingOrdinaryCellCreatesNewCellButGeneratedDuplicateIsRejected() {
  const tex = String.raw`\begin{cells}
\begin{mdcell}
A
\end{mdcell}
\end{cells}`;
  const root = { schema_version: 1, source_file: 'a.tex', cells: [manifestCell('a', 'markdown', 'A')] };
  const out = syncNotebookToTex(tex, root, [
    { kind: 'markdown', source: 'A', sync_id: 'a' },
    { kind: 'markdown', source: 'A copy', sync_id: 'a' },
  ]);
  assert.strictEqual(out.summary.added, 1);
  assert(out.newText.includes('A copy'));

  const virtualRoot = {
    schema_version: 1,
    source_file: 'a.tex',
    cells: [manifestCell('h', 'markdown', '## Exercise 1', '## Exercise 1', {
      tex_backed: false, read_only: true, owner_environment: 'cells', owner_position: 'begin', owner_line_hint: 1,
    }), manifestCell('a', 'markdown', 'A')],
  };
  assert.throws(
    () => syncNotebookToTex(tex, virtualRoot, [
      { kind: 'markdown', source: '## Exercise 1', sync_id: 'h' },
      { kind: 'markdown', source: '## Exercise 1', sync_id: 'h' },
      { kind: 'markdown', source: 'A', sync_id: 'a' },
    ]),
    /read-only.*duplicated/i,
  );
})();

(function testReorderWithinOnePyexerciseDoesNotRequireOtherExercisesToShareParent() {
  const tex = String.raw`\begin{pyexercise}{one}
\begin{mdcell}
A
\end{mdcell}
\begin{mdcell}
B
\end{mdcell}
\end{pyexercise}

\begin{pyexercise}{two}
\begin{mdcell}
C
\end{mdcell}
\end{pyexercise}`;
  const root = {
    schema_version: 1,
    source_file: 'lesson.tex',
    cells: [
      manifestCell('h1', 'markdown', '## Exercise 1.1', '## Exercise 1.1', {
        tex_backed: false, read_only: true, owner_environment: 'pyexercise', owner_position: 'begin', owner_line_hint: 1,
      }),
      manifestCell('a', 'markdown', 'A'),
      manifestCell('b', 'markdown', 'B'),
      manifestCell('h2', 'markdown', '## Exercise 1.2', '## Exercise 1.2', {
        tex_backed: false, read_only: true, owner_environment: 'pyexercise', owner_position: 'begin', owner_line_hint: 9,
      }),
      manifestCell('c', 'markdown', 'C'),
    ],
  };
  const out = syncNotebookToTex(tex, root, [
    { kind: 'markdown', source: '## Exercise 1.1', sync_id: 'h1' },
    { kind: 'markdown', source: 'B', sync_id: 'b' },
    { kind: 'markdown', source: 'A', sync_id: 'a' },
    { kind: 'markdown', source: '## Exercise 1.2', sync_id: 'h2' },
    { kind: 'markdown', source: 'C', sync_id: 'c' },
  ]);
  const firstBegin = out.newText.indexOf('\\begin{pyexercise}{one}');
  const b = out.newText.indexOf('\nB\n', firstBegin);
  const a = out.newText.indexOf('\nA\n', firstBegin);
  const firstEnd = out.newText.indexOf('\\end{pyexercise}', firstBegin);
  const secondBegin = out.newText.indexOf('\\begin{pyexercise}{two}');
  const c = out.newText.indexOf('\nC\n', secondBegin);
  assert(firstBegin < b && b < a && a < firstEnd && firstEnd < secondBegin && secondBegin < c);
  assert.strictEqual(out.summary.reordered, true);
})();


(function testCannotInsertBeforeFirstGeneratedPyexerciseHeading() {
  const tex = String.raw`\begin{pyexercise}{first}
\begin{mdcell}
A
\end{mdcell}
\end{pyexercise}`;
  const root = {
    schema_version: 1,
    source_file: 'lesson.tex',
    cells: [
      manifestCell('h1', 'markdown', '## Exercise 1.1', '## Exercise 1.1', {
        tex_backed: false, read_only: true, owner_environment: 'pyexercise', owner_position: 'begin', owner_line_hint: 1,
      }),
      manifestCell('a', 'markdown', 'A'),
    ],
  };
  assert.throws(
    () => syncNotebookToTex(tex, root, [
      { kind: 'markdown', source: 'New before heading' },
      { kind: 'markdown', source: '## Exercise 1.1', sync_id: 'h1' },
      { kind: 'markdown', source: 'A', sync_id: 'a' },
    ]),
    /before a generated read-only owner heading/i,
  );
})();


(function testCommentedAndOpaqueFakeCellsAreIgnored() {
  const tex = String.raw`% \begin{mdcell}
% fake commented cell
% \end{mdcell}
\begin{comment}
\begin{pycell}
print("not real")
\end{pycell}
\end{comment}
\begin{verbatim}
\begin{mdcell}
not real either
\end{mdcell}
\end{verbatim}
\begin{realowner}
% \begin{fakeowner}
\begin{mdcell}
REAL
\end{mdcell}
% \end{fakeowner}
\end{realowner}`;
  const cells = parseCells(tex);
  assert.strictEqual(cells.length, 1);
  assert.strictEqual(cells[0].body.trim(), 'REAL');
  assert.strictEqual(cells[0].parent.name, 'realowner');
})();

(function testCommentedEndTokenDoesNotTerminateCell() {
  const tex = String.raw`\begin{mdcell}
first line
% \end{mdcell}
second line
\end{mdcell}`;
  const cells = parseCells(tex);
  assert.strictEqual(cells.length, 1);
  assert(cells[0].body.includes('second line'));
})();

(function testOwnerOccurrenceBeatsStaleLineHint() {
  const tex = String.raw`\begin{pyexercise}{first}
\begin{mdcell}
A with many\nlines\nadded\nto\nmove\nlater\nline\nhints
\end{mdcell}
\end{pyexercise}

\begin{pyexercise}{empty}
\end{pyexercise}`;
  const root = {
    schema_version: 1,
    source_file: 'lesson.tex',
    cells: [
      manifestCell('h1', 'markdown', '## Exercise 1.1', '## Exercise 1.1', {
        tex_backed: false, read_only: true, owner_environment: 'pyexercise', owner_position: 'begin',
        owner_line_hint: 1, owner_occurrence: 1,
      }),
      manifestCell('a', 'markdown', 'A with many\\nlines\\nadded\\nto\\nmove\\nlater\\nline\\nhints', 'A with many\\nlines\\nadded\\nto\\nmove\\nlater\\nline\\nhints'),
      manifestCell('h2', 'markdown', '## Exercise 1.2', '## Exercise 1.2', {
        tex_backed: false, read_only: true, owner_environment: 'pyexercise', owner_position: 'begin',
        owner_line_hint: 2, owner_occurrence: 2,
      }),
    ],
  };
  const out = syncNotebookToTex(tex, root, [
    { kind: 'markdown', source: '## Exercise 1.1', sync_id: 'h1' },
    { kind: 'markdown', source: 'A with many\\nlines\\nadded\\nto\\nmove\\nlater\\nline\\nhints', sync_id: 'a' },
    { kind: 'markdown', source: '## Exercise 1.2', sync_id: 'h2' },
    { kind: 'code', source: 'inside_empty()', sync_id: null },
  ]);
  const secondBegin = out.newText.indexOf('\\begin{pyexercise}{empty}');
  const inserted = out.newText.indexOf('inside_empty()');
  const secondEnd = out.newText.indexOf('\\end{pyexercise}', secondBegin);
  assert(secondBegin < inserted && inserted < secondEnd);
})();

console.log('All syncCore tests passed.');
