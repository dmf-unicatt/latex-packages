# Define the default base image
# NOTE: build arguments used by FROM must be declared before FROM
ARG BASE_IMAGE=debian:testing

# Use the base image from the build argument
FROM ${BASE_IMAGE}

# Define the default value for the APT_PYTHON_PACKAGES build argument
# which controls whether to install Python packages via apt (if true)
# or pip (if false, default).
# NOTE: Build arguments used inside this build stage must be declared after FROM
#       We duplicate the BASE_IMAGE argument here to ensure it is available
#       in the build stage, and not just in the FROM instruction.
ARG BASE_IMAGE
ARG APT_PYTHON_PACKAGES=false

# Set environment variable to avoid interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Switch to old releases for EOL ubuntu
RUN set -e; \
    case "$BASE_IMAGE" in \
        *ubuntu*) \
            if apt update -y 2>&1 | grep -q "does not have a Release file"; then \
                if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then \
                    sed -i -E 's@http://(archive|security)\.ubuntu\.com/ubuntu@http://old-releases.ubuntu.com/ubuntu@g' /etc/apt/sources.list.d/ubuntu.sources; \
                else \
                    sed -i -E 's@http://(archive|security)\.ubuntu\.com/ubuntu@http://old-releases.ubuntu.com/ubuntu@g' /etc/apt/sources.list; \
                fi; \
                apt update -y; \
            fi \
            ;; \
        *) \
            ;; \
    esac

# Install required apt packages
RUN apt update -y -q && \
    # Install basic commands
    apt install -y -qq --no-install-recommends git patch && \
    # Install texlive
    apt install -y -qq --no-install-recommends texlive-extra-utils texlive-humanities texlive-latex-extra texlive-lang-english texlive-science; \
    # Install additional required LaTeX related packages
    apt install -y -qq --no-install-recommends latexmk poppler-utils && \
    # Install fonts for plotly
    apt install -y -qq --no-install-recommends fonts-noto && \
    # Install required Python packages via apt. Note that python3-pygments
    # is required by PythonTeX, hence it is installed via apt regardless
    # of the APT_PYTHON_PACKAGES value.
    apt install -y -qq --no-install-recommends python-is-python3 python3-pip python3-pygments && \
    if [ "$APT_PYTHON_PACKAGES" = "true" ]; then \
        apt install -y -qq --no-install-recommends python3-imagehash python3-nbval python3-pandas python3-pil python3-sympy; \
    fi && \
    # Clean cache
    apt clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Apply pythontex patch to avoid python warnings
COPY patches/pythontex /tmp/patches-pythontex
RUN if [ -s "/tmp/patches-pythontex/PR_223-${BASE_IMAGE}.patch" ]; then \
        echo "Applying patch PR_223-${BASE_IMAGE}.patch"; \
        patch -p0 < /tmp/patches-pythontex/PR_223-${BASE_IMAGE}.patch; \
    else \
        echo "Patch file is empty, skipping."; \
    fi \
    && rm -rf /tmp/patches-pythontex

# Apply mdcell patch on old latex versions
# (on new latex versions the patch is left empty, and will not be applied)
COPY patches/markdown /tmp/patches-markdown
RUN if [ -s "/tmp/patches-markdown/mdcell-${BASE_IMAGE}.patch" ]; then \
        echo "Applying patch mdcell-${BASE_IMAGE}.patch"; \
        patch -p0 < /tmp/patches-markdown/mdcell-${BASE_IMAGE}.patch; \
    else \
        echo "Patch file is empty, skipping."; \
    fi \
    && rm -rf /tmp/patches-markdown

# Apply neuralnetwork patch to avoid LuaTeX warnings
COPY patches/neuralnetwork/drop_tikz_semicolons.patch /tmp/drop_tikz_semicolons.patch
COPY patches/neuralnetwork/add_if_false_branch.patch /tmp/add_if_false_branch.patch
RUN patch -p0 < /tmp/drop_tikz_semicolons.patch && rm /tmp/drop_tikz_semicolons.patch && \
    patch -p0 < /tmp/add_if_false_branch.patch && rm /tmp/add_if_false_branch.patch

# Update LuaTeX font database
RUN luaotfload-tool -u

# Install required Python packages via pip. For APT_PYTHON_PACKAGES=true,
# use pip only for packages that are unavailable or too old in Debian.
RUN export PIP_BREAK_SYSTEM_PACKAGES=1 && \
    if [ "$APT_PYTHON_PACKAGES" = "true" ]; then \
        python3 -m pip install --no-cache-dir nbdime kaleido plotly; \
    else \
        python3 -m pip install --no-cache-dir ImageHash kaleido nbdime nbval pandas pillow plotly sympy; \
    fi

# Install chromium (in debian) or chrome (in ubuntu) for kaleido
RUN apt update -y -q && \
    # Determine the base image and install the appropriate browser:
    # Debian supports apt installable chromium and chromium-driver packages,
    # and therefore we use them.
    # Ubuntu has chromium-browser and chromium-chromedriver package, but they
    # actually require snap packages to work. In principle we could have let
    # plotly install its own version of chrome via plotly_get_chrome, but
    # their script does not automatically install the required apt depencies,
    # rendering the installed browser uselss. For this reason, we install
    # Google Chrome instead of chromium, even though using the proprietary
    # implementation must be interpreted as a last resort and temporary
    # workaround until upstream projects provide better installation support.
    case "$BASE_IMAGE" in \
        *ubuntu*) \
            apt install -y -qq --no-install-recommends wget && \
            wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/google-chrome.deb && \
            apt install -y -qq --no-install-recommends /tmp/google-chrome.deb && \
            rm /tmp/google-chrome.deb; \
            ;; \
        *debian*) \
            apt install -y -qq --no-install-recommends chromium chromium-driver; \
            ;; \
        *) \
            echo "Invalid base image: $BASE_IMAGE. Please use a supported Debian or Ubuntu base image."; \
            exit 1; \
            ;; \
    esac && \
    # Clean cache
    apt clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
