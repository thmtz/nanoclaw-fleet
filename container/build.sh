#!/bin/bash
# Build the NanoClaw agent container image.
#
# Reads one optional build flag from ../.env:
#   INSTALL_CJK_FONTS=true   — add Chinese/Japanese/Korean fonts (~200MB)
# setup/container.ts reads the same file, so both build paths stay in sync.
# Callers can also override by exporting INSTALL_CJK_FONTS directly.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

# Derive the image name from the project root so two NanoClaw installs on the
# same host don't overwrite each other's `nanoclaw-agent:latest` tag. Matches
# setup/lib/install-slug.sh + src/install-slug.ts.
# shellcheck source=../setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
IMAGE_NAME="$(container_image_base)"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Caller's env takes precedence; fall back to .env.
if [ -z "${INSTALL_CJK_FONTS:-}" ] && [ -f "../.env" ]; then
    INSTALL_CJK_FONTS="$(grep '^INSTALL_CJK_FONTS=' ../.env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
fi

BUILD_ARGS=()
if [ "${INSTALL_CJK_FONTS:-false}" = "true" ]; then
    echo "CJK fonts: enabled (adds ~200MB)"
    BUILD_ARGS+=(--build-arg INSTALL_CJK_FONTS=true)
fi

PERSONAL_DOCKERFILE="${HOME}/.config/nanoclaw/Dockerfile"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Always build the base image first. Personal layer (if any) stacks on top.
${CONTAINER_RUNTIME} build "${BUILD_ARGS[@]}" -t "${IMAGE_NAME}:base" .

# Personal Dockerfile overlay — v1 fleet convention. If the user has a
# personal Dockerfile at ~/.config/nanoclaw/Dockerfile it MUST start with
#   FROM <image_name>:base
# …where image_name matches this install's slug. The build context is
# ~/.config/nanoclaw so COPY directives can reference any file under it.
#
# If no personal file exists, the base image is retagged as the final
# ${TAG} so callers get a single deterministic artifact either way.
if [ -f "$PERSONAL_DOCKERFILE" ]; then
    echo ""
    echo "Found personal Dockerfile at $PERSONAL_DOCKERFILE"
    echo "Layering personal additions on top of ${IMAGE_NAME}:base..."
    # Pass the base image name as a build-arg so user Dockerfiles can write
    # `ARG BASE` + `FROM ${BASE}` instead of hardcoding the slugged name.
    ${CONTAINER_RUNTIME} build \
        --build-arg "BASE=${IMAGE_NAME}:base" \
        -t "${IMAGE_NAME}:${TAG}" \
        -f "$PERSONAL_DOCKERFILE" \
        "$HOME/.config/nanoclaw"
else
    ${CONTAINER_RUNTIME} tag "${IMAGE_NAME}:base" "${IMAGE_NAME}:${TAG}"
fi

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
