#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"
PERSONAL_DOCKERFILE="${HOME}/.config/nanoclaw/Dockerfile"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Build the public base image
${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:base" .

# Layer personal additions if a personal Dockerfile exists.
# The personal Dockerfile should use FROM nanoclaw-agent:base.
if [ -f "$PERSONAL_DOCKERFILE" ]; then
  echo ""
  echo "Found personal Dockerfile at ${PERSONAL_DOCKERFILE}"
  echo "Building personal layer on top of base..."
  ${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" -f "$PERSONAL_DOCKERFILE" "$HOME/.config/nanoclaw"
else
  # No personal layer — tag base as the final image
  ${CONTAINER_RUNTIME} tag "${IMAGE_NAME}:base" "${IMAGE_NAME}:${TAG}"
fi

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
