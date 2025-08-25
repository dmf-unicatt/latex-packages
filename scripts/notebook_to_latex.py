import argparse

import nbclient
import nbformat


def notebook_to_latex(input_path: str, output_path: str) -> None:
    r"""
    Execute a Jupyter notebook and transform it into a LaTeX-like format.

    Markdown cells are converted to:
        \begin{mdcell}
        ...
        \end{mdcell}

    Code cells are converted to:
        \begin{pycell}
        ...
        \end{pycell}

    Text outputs from code cells (e.g., print statements) are converted to:
        \begin{pyexpectedoutput}
        ...
        \end{pyexpectedoutput}

    Parameters
    ----------
    input_path
        Path to the input Jupyter notebook (.ipynb).
    output_path
        Path to the output text file where the transformed notebook will be saved.
    """
    # Load notebook
    nb = nbformat.read(input_path, as_version=4)

    # Execute the notebook
    client = nbclient.NotebookClient(nb)
    client.execute()

    with open(output_path, "w", encoding="utf-8") as out:
        for cell in nb.cells:
            if cell.cell_type == "markdown":
                out.write("\\begin{mdcell}\n")
                out.write("".join(cell.source))
                out.write("\n\\end{mdcell}\n\n")
            elif cell.cell_type == "code":
                # Write the code
                out.write("\\begin{pycell}\n")
                out.write("".join(cell.source))
                out.write("\n\\end{pycell}\n\n")

                # Process outputs
                for output in cell.get("outputs", []):
                    text: str = ""
                    if output.output_type == "stream":
                        text = "".join(output.text)
                    elif output.output_type == "execute_result":
                        if "text/plain" in output.data:
                            text = "".join(output.data["text/plain"])
                    if text.strip():
                        out.write("\\begin{pyexpectedoutput}\n")
                        out.write(text)
                        out.write("\n\\end{pyexpectedoutput}\n\n")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Transform a Jupyter notebook into LaTeX cells.")
    parser.add_argument("input_file", type=str, help="Path to the input notebook (.ipynb)")
    parser.add_argument("output_file", type=str, help="Path to save the transformed output")

    args = parser.parse_args()

    notebook_to_latex(args.input_file, args.output_file)
    print(f"Notebook executed and transformed to {args.output_file}")
