% beamerunicatt.cls
\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{pybeamerlectureslides}[2025/08/19 Lectures slides based on beamer with unicatt defaults]

% Load parent class theme
\LoadClass{beamerunicatt}

% Set default author and affiliation
\author[F. Ballarin]{\underline{\textbf{Francesco Ballarin}}$^{1,2}$}
\institute[Università Cattolica del Sacro Cuore]{%
$ ^{1}$ Università~Cattolica~del~Sacro~Cuore,\\
\hspace{0.7em} Department~of~Mathematics~and~Physics, Brescia,~Italy\\[1ex]
$ ^{2}$ Università~Cattolica~del~Sacro~Cuore,\\
\hspace{0.7em} Department~of~Mathematics~for~Economic,~Financial\\
\hspace{0.7em} and~Actuarial~Sciences, Milano,~Italy
}

% LaTeX3 programming layer
\RequirePackage{expl3}

% Load tikz
\RequirePackage{tikz}
\usetikzlibrary{arrows,automata,calc,decorations.pathmorphing,intersections,positioning,shapes.geometric}
\RequirePackage{pgfplots}
\usepgfplotslibrary{groupplots,patchplots}
\pgfplotsset{compat=1.18}

% Load tabularx and colortbl to typeset tables
\RequirePackage{tabularx}
\RequirePackage{colortbl}

% Load package for nicer small fractions
\RequirePackage{nicefrac}

% Load package for neural networks
\RequirePackage{neuralnetwork}

% Load packages to refer to environments defined in another files
\RequirePackage{xr-hyper}
\RequirePackage{luacode}
\RequirePackage{xstring}

%%% ================================================================
%%%                           PACKAGE OPTIONS
%%% ================================================================

\ExplSyntaxOn

% Variables storing the package options
\tl_new:N \l_chapter_file_prefix_tl
\tl_new:N \l_slide_file_prefix_tl

% Define keys and default values
\keys_define:nn { py-beamer-lecture-slides }
  {
    chapter-file-prefix .tl_set:N = \l_chapter_file_prefix_tl,
    chapter-file-prefix .initial:n = {}, % default is empty string

    slide-file-prefix .tl_set:N = \l_slide_file_prefix_tl,
    slide-file-prefix .initial:n = {}, % default is empty string
  }

% Set default values
\keys_set:nn { py-beamer-lecture-slides }
  { chapter-file-prefix = {}, slide-file-prefix = {} }

% Process unknown package options as key-values
\DeclareOption*{
  \edef\processoption{\noexpand\keys_set:nn { py-beamer-lecture-slides } { \CurrentOption }}
  \processoption
}
\ProcessOptions\relax

\ExplSyntaxOff

%%% ================================================================
%%%                       HELPER TO INCLUDE CHAPTERS
%%% ================================================================

\begin{luacode*}
function ExternalDocumentsFromFolder(folder, exclude)
  -- normalize folder path
  folder = folder:gsub("\\\\","/")
  folder = folder:gsub("/+$","") .. "/"

  -- normalize exclude path
  if exclude == nil then exclude = "" end
  exclude = tostring(exclude)
  exclude = exclude:gsub("^%s+",""):gsub("%s+$","")

  -- helper: fatal error
  local function fatal(msg)
    tex.error("[ExternalDocumentsFromFolder] " .. msg)
  end

  -- helper: log
  local function info(msg)
    texio.write_nl("[ExternalDocumentsFromFolder] " .. msg)
  end

  -- helper: emit \externaldocument
  local function emit(texname)
    local auxfile = texname .. ".aux"
    local f = io.open(auxfile, "r")
    if f then
      f:close()
      tex.print("\\externaldocument{" .. texname .. "}")
      info("Imported " .. texname .. ".aux")
    else
      fatal("Missing .aux file: '" .. auxfile .. "'. Compilation cannot continue. Did you compile the main document (book mode) first?")
    end
  end

  -- use LuaFileSystem to scan folder
  local ok, lfs = pcall(require, "lfs")
  if ok and lfs then
    local files = {}
    for entry in lfs.dir(folder) do
      if entry:match("%.tex$") then
        local base = entry:gsub("%.tex$","")
        -- skip the excluded basename if requested
        if base ~= exclude then
          table.insert(files, base)
          info("Found " .. entry)
        else
          info("Skipping (excluded) " .. entry)
        end
      end
    end
    table.sort(files)
    for _, base in ipairs(files) do
      emit(folder .. base)
    end
  else
    fatal("LuaFileSystem (lfs) not available; cannot scan folder: " .. folder)
  end
end
\end{luacode*}

\NewDocumentCommand{\includechapter}{m}
  {
    \edef\chapterfile{#1}%
    \directlua{
      ExternalDocumentsFromFolder("chapters", "\luaescapestring{\chapterfile}")
    }%
    \include{chapters/\chapterfile}%
  }

% Redirect hyperref external link to the actual file containing the label,
% using the prefix specified in the package options. Inspired by
% https://github.com/latex3/hyperref/issues/415
\ExplSyntaxOn
\AtBeginDocument{
  \long\def\beamer@ref#1{%
    \tl_if_empty:eTF{\tl_item:cn{r@#1}{5}}
     {
      \hyperlink{#1}{\beamer@origref{#1}}%
     }
     {
      % Capture the external doc name (e.g., chapters/foo)
      \tl_set:Nx \l_pb_ref_doc_tl { \tl_item:cn{r@#1}{5} }%
      \edef\pbls@refdoc{\tl_use:N \l_pb_ref_doc_tl}%
      \IfFileExists{\pbls@refdoc}{
        % if the file exists, link to it
        \typeout{label~`#1'~is~in~external~doc~(no~preprocessing~needed)~`\pbls@refdoc'}%
        \hyper@linkfile{\beamer@origref{#1}}{\pbls@refdoc}{\tl_item:cn{r@#1}{4}}
      }%
      {
        % Drop the leading chapters/ directory
        \IfBeginWith{\pbls@refdoc}{chapters/}
          {\StrBehind{\pbls@refdoc}{chapters/}[\pbls@refdoc]}
          {}
        % If a chapter-file-prefix is configured, strip it from the start
        \tl_if_blank:VF \l_chapter_file_prefix_tl
          {
            \edef\pbls@chapterprefix{\tl_use:N \l_chapter_file_prefix_tl}%
            \IfBeginWith{\pbls@refdoc}{\pbls@chapterprefix}
              {\StrBehind{\pbls@refdoc}{\pbls@chapterprefix}[\pbls@refdoc]}
              {}
          }
        % If a slide-file-prefix is configured, add it to the start
        \tl_if_blank:VF \l_slide_file_prefix_tl
          {
            \edef\pbls@slideprefix{\tl_use:N \l_slide_file_prefix_tl}%
            \edef\pbls@refdoc{\pbls@slideprefix\pbls@refdoc}%
          }
        \typeout{label~`#1'~is~in~external~doc~(after~processing)~`\pbls@refdoc'}%
        \hyper@linkfile{\beamer@origref{#1}}{\pbls@refdoc}{\tl_item:cn{r@#1}{4}}%
      }
     }%
  }
}
\ExplSyntaxOff
