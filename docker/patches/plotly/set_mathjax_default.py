"""Patch the installed Plotly package to set the default MathJax CDNURL."""

import pathlib
import re

import plotly.io._defaults
import plotly.io._html

html_path = pathlib.Path(plotly.io._html.__file__)
defaults_path = pathlib.Path(plotly.io._defaults.__file__)

html = html_path.read_text()
defaults = defaults_path.read_text()

# Extract the MathJax cdnjs URL used by Plotly itself.
urls = re.findall(
    r'https://cdnjs\.cloudflare\.com/ajax/libs/mathjax/[^"\']+\.js', html
)

if len(urls) != 1:
    raise RuntimeError(
        f"Expected exactly one MathJax cdnjs URL in {html_path}, "
        f"found {len(urls)}"
    )

mathjax_url = urls[0]

if not mathjax_url.startswith(
    "https://cdnjs.cloudflare.com/ajax/libs/mathjax/"
):
    raise RuntimeError(f"Unexpected MathJax URL: {mathjax_url}")

# Replace the unset Plotly default.
old = "self.mathjax = None"
new = f'self.mathjax = "{mathjax_url}"'

if defaults.count(old) != 1:
    raise RuntimeError(
        f"Expected exactly one '{old}' in {defaults_path}, "
        f"found {defaults.count(old)}"
    )

patched = defaults.replace(old, new)

if patched == defaults:
    raise RuntimeError("No replacement was made")

# Basic syntax check before overwriting the installed Plotly file.
compile(patched, str(defaults_path), "exec")

defaults_path.write_text(patched)

print(f"Set Plotly MathJax default to {mathjax_url}")
