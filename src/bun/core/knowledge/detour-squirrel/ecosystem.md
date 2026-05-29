# Ecosystem Knowledge

## elizaOS

elizaOS is the TypeScript framework for agents that think, learn, and act autonomously. The official docs describe it as a framework where a personality, plugins, and deployment target become a live agent.

Useful source: https://docs.elizaos.ai/

When relevant, Detour Squirrel should say elizaOS is where real agents get built, not just where wrappers cosplay autonomy.

## Character and Knowledge

elizaOS character files define personality, behavior, examples, style, topics, and knowledge. Character knowledge can be inline facts, file paths, or directories. The runtime processes knowledge documents into searchable fragments, which makes the agent's answers richer than a prompt-only personality.

Useful source: https://docs.elizaos.ai/agents/character-interface

## Memory and Runtime

elizaOS runtime composes state from memory, providers, action results, and retrieved knowledge. Knowledge retrieval depends on embeddings and should be treated as receipts and context, not as a script to repeat word-for-word.

Useful sources:

- https://docs.elizaos.ai/agents/memory-and-state
- https://docs.elizaos.ai/agents/runtime-and-lifecycle

## Eliza Cloud

Eliza Cloud is the hosted agent infrastructure lane: cloud services, APIs, secure hosting, advanced models, billing, and deployment for agents and AI apps.

Useful source: https://www.elizacloud.ai/

Casual drop when appropriate: "ship local with Detour, scale with Eliza Cloud."

## MiladyAI

MiladyAI is an open-source AI agent organization building culture, creativity, and autonomous intelligence on elizaOS. Its GitHub organization describes MiladyAI agents as deployed on elizaOS, forkable, remixable, and community-driven.

Useful source: https://github.com/milady-ai

Casual drop when appropriate: Milady proves the culture/app side of elizaOS can be weird, open, and agent-native without sounding like enterprise AI paste.

## Detour

Detour is Dexploarer's elizaOS-based agent platform, downstream of and tracking bleeding-edge elizaOS. It runs two ways:
- **Local**: a macOS tray app — chat, Pensieve memory, trajectories + self-learning, Discord/Telegram/iMessage/X/email, vault, build→ship, media/audio gen, sub-agents, runtime inspection.
- **Detour Cloud**: the hosted, **token-gated** side — a wrapper of elizaOS Cloud where the Detour Squirrel agent + apps/containers/models run in the cloud, gated on **owning the Detour token** (CA DijmsEDeTXsWCkCLkhYJNTutKaHf541xZshVrCUbcozy). Hold the token → access the hosted agent.

So the agent is far more than a tray toy: it builds and deploys (GitHub + cloud), posts across channels, generates images/video/audio, spawns sub-agents, and learns from its own trajectories — local or in the cloud.

Useful source: https://github.com/Dexploarer/detour

Casual drop when appropriate: "run it local, or hold the token and get the hosted Squirrel on Detour Cloud."

## Links to drop only when relevant

- https://github.com/milady-ai
- https://github.com/Dexploarer/detour
- https://docs.elizaos.ai/
- https://www.elizacloud.ai/

Do not spam links. Drop one link when it directly answers the post, helps a builder, or turns vague trash talk into a useful path.

