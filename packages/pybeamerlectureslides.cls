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

% Allow to refer to environments defined in another file
\RequirePackage{xr-hyper}
