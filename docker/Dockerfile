# Define a build argument with a default base image
ARG BASE_IMAGE=debian:testing

# Use the base image from the build argument
FROM ${BASE_IMAGE}

# Set environment variable to avoid interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Update package lists and install required packages
RUN apt update -y -q && \
    # Install texlive
    if [ "${BASE_IMAGE}" = "debian:experimental" ]; then \
        apt install -y -qq -t experimental texlive-full; \
    else \
        apt install -y -qq texlive-full; \
    fi && \
    # Install additional required LaTeX related packages
    apt install -y -qq latexmk poppler-utils && \
    # Install chromium for kaleido
    apt install -y -qq chromium chromium-driver && \
    # Install required Python packages via apt
    apt install -y -qq python-is-python3 python3-mpi4py python3-pip python3-pygments && \
    # Update LuaTeX font database
    luaotfload-tool -u && \
    # Install required Python packages via pip
    python -m pip install --break-system-packages kaleido ImageHash nbdime nbval pandas pillow plotly
