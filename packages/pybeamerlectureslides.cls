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

% Load tikz
\RequirePackage{tikz}
\usetikzlibrary{calc,intersections,shapes.geometric}
\RequirePackage{pgfplots}
\usepgfplotslibrary{patchplots}
\pgfplotsset{compat=1.18}

% Load tabularx
\RequirePackage{tabularx}

% Load package for nicer small fractions
\RequirePackage{nicefrac}

% Allow to refer to environments defined in another file
\RequirePackage{xr-hyper}
\RequirePackage{luacode}
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
