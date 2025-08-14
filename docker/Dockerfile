# Define a build argument with a default base image
ARG BASE_IMAGE=debian:testing

# Use the base image from the build argument
FROM ${BASE_IMAGE}

# Set the base image as environment variable for later use in RUN steps
ARG BASE_IMAGE
ENV BASE_IMAGE=${BASE_IMAGE}

# Set environment variable to avoid interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Switch to old releases for EOL ubuntu
RUN set -e; \
    case "$BASE_IMAGE" in \
        *ubuntu*) \
            if apt update -y 2>&1 | grep -q "does not have a Release file"; then \
                sed -i -E 's@http://(archive|security)\.ubuntu\.com/ubuntu@http://old-releases.ubuntu.com/ubuntu@g' /etc/apt/sources.list; \
                apt update -y; \
            fi \
            ;; \
        *) \
            ;; \
    esac

# Update package lists and install required packages, then clean cache
RUN apt update -y -q && \
    # Install git
    apt install -y -qq --no-install-recommends git && \
    # Install texlive
    if [ "${BASE_IMAGE}" = "debian:experimental" ]; then \
        apt install -y -qq -t experimental --no-install-recommends texlive-extra-utils texlive-latex-extra texlive-lang-english; \
    else \
        apt install -y -qq --no-install-recommends texlive-extra-utils texlive-latex-extra texlive-lang-english; \
    fi && \
    # Install additional required LaTeX related packages
    apt install -y -qq --no-install-recommends latexmk poppler-utils && \
    # Install chromium for kaleido
    if apt-cache policy chromium | grep Candidate | grep -v '(none)' >/dev/null 2>&1; then \
        apt install -y -qq --no-install-recommends chromium chromium-driver; \
    fi && \
    # Install required Python packages via apt
    apt install -y -qq --no-install-recommends python-is-python3 python3-mpi4py python3-pip python3-pygments && \
    # Clean cache
    apt clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Update LuaTeX font database
RUN luaotfload-tool -u

# Install required Python packages via pip with no cache
RUN export PIP_BREAK_SYSTEM_PACKAGES=1 && \
    python3 -m pip install --no-cache-dir ImageHash nbdime nbval pandas pillow sympy && \
    if command -v chromium >/dev/null 2>&1; then \
        python3 -m pip install --no-cache-dir kaleido plotly; \
    else \
        python3 -m pip install --no-cache-dir "kaleido<1.0.0" "plotly<6.2.0"; \
    fi
