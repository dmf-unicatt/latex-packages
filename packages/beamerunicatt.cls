% beamerunicatt.cls
\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{beamerunicatt}[2025/08/19 Beamer with unicatt defaults]

% Pass default options to beamer
\PassOptionsToClass{9pt,compress,t,xcolor={RGB},aspectratio=169,mathserif}{beamer}
\LoadClass{beamer}

% Load Latin Modern as default font
\RequirePackage{lmodern}

% Load math packages
\RequirePackage{amsmath}
\RequirePackage{amssymb}
\RequirePackage{amsfonts}

% Load graphics packages
\RequirePackage{graphicx}

% Load your theme automatically
\RequirePackage{beamerthemeunicatt}
