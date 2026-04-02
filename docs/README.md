# Documentation

## Architecture

How the system works (current state of the code):

- [Overview](architecture/overview.md) — Goals, design principles, 1000ft architecture
- [Inference routing](architecture/inference-routing.md) — How API traffic flows to Anthropic or Neuralwatt
- [Model discovery](architecture/model-discovery.md) — Fuzzy model matching for Neuralwatt
- [Container lifecycle](architecture/container-lifecycle.md) — Create, run, destroy, resume
- [Streaming shim](architecture/streaming-shim.md) — SSE translation for Neuralwatt
- [Energy tracking](architecture/energy-tracking.md) — Per-worker usage metrics

## Guides

How to do X (step-by-step):

- [Setup](guides/setup.md) — Getting started with dynamic workers on Discord
- [Testing](guides/testing.md) — Exercising every behavior end-to-end
- [Troubleshooting](guides/troubleshooting.md) — Common issues and fixes

## Reference

Lookup-oriented:

- [SDK internals](reference/sdk-internals.md) — Claude Agent SDK deep dive

## Upstream Docs

Original NanoClaw documentation (from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)):

- [Spec](upstream/SPEC.md) — Original full specification
- [Requirements](upstream/REQUIREMENTS.md) — Original design philosophy
- [Security](upstream/SECURITY.md) — Security model
- [Skills as branches](upstream/skills-as-branches.md) — Skill system design
- [Docker sandboxes](upstream/docker-sandboxes.md) — Running in Docker Sandbox
- [Apple Container networking](upstream/APPLE-CONTAINER-NETWORKING.md) — macOS networking

## Design Docs

Proposals and design history live in [/design](../design/) (separate from docs to avoid confusing current state with aspirational state).
