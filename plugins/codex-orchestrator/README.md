# Codex Orchestrator - Claude Code Plugin

A Claude Code plugin that lets Claude orchestrate OpenAI Codex agents. Claude handles strategy and synthesis while Codex agents handle deep coding work in parallel tmux sessions.

## What It Does

When installed, Claude gains the ability to:

- **Spawn Codex agents** for research, implementation, review, and testing
- **Spawn Gemini agents** for UI/UX ideation, critique, and A/B variant generation
- **Monitor agent progress** via structured JSON output
- **Redirect agents mid-task** when they need course correction
- **Synthesize findings** from multiple parallel agents into clear results
- **Follow a structured pipeline**: Ideation -> Research -> Synthesis -> PRD -> Implementation -> Review -> Testing

You describe what you want. Claude breaks it into tasks, delegates to Codex agents, monitors progress, and reports back.

## Installation

### Via Marketplace

```
/plugin marketplace add kingbootoshi/codex-orchestrator
/plugin install codex-orchestrator
```

### Manual

Clone and install:

```bash
git clone https://github.com/kingbootoshi/codex-orchestrator.git ~/.codex-orchestrator
cd ~/.codex-orchestrator && bun install
export PATH="$HOME/.codex-orchestrator/bin:$PATH"  # add to ~/.bashrc or ~/.zshrc
```

### Dependencies

The `codex-agent` CLI and its dependencies must be installed:

```bash
# Install tmux
brew install tmux                  # macOS
# sudo apt-get install -y tmux    # Ubuntu/Debian

# Install Bun
curl -fsSL https://bun.sh/install | bash

# Install OpenAI Codex CLI
npm install -g @openai/codex

# Authenticate with OpenAI (required)
codex --login

# Install codex-orchestrator CLI
git clone https://github.com/kingbootoshi/codex-orchestrator.git ~/.codex-orchestrator
cd ~/.codex-orchestrator && bun install
export PATH="$HOME/.codex-orchestrator/bin:$PATH"  # add to ~/.bashrc or ~/.zshrc
```

Or use the bundled installer:

```bash
bash plugins/codex-orchestrator/scripts/install.sh
```

## Usage

The skill activates automatically when you ask Claude to do coding tasks:

```
/codex-orchestrator
```

Or just describe what you want:
- "investigate the auth module for security issues"
- "implement the feature from the PRD"
- "review the recent changes"
- "run tests and fix failures"

Claude will spawn appropriate Codex agents and manage the process.

## The Pipeline

```
YOUR REQUEST
     |
     v
[IDEATION] --> [RESEARCH] --> [SYNTHESIS] --> [PRD] --> [IMPLEMENTATION] --> [REVIEW] --> [TESTING]
  Claude        Codex          Claude         Claude      Codex             Codex         Codex
  + You         read-only                     + You       workspace-write   read-only     workspace-write
```

**Claude** handles strategic stages: ideation, synthesis, PRD creation.
**Codex agents** handle execution stages: research, implementation, review, testing.

## Agent Timing

Codex agents take time - this is normal and expected:

| Task Type | Typical Duration |
|-----------|------------------|
| Simple research | 10-20 minutes |
| Single feature | 20-40 minutes |
| Complex implementation | 30-60+ minutes |

## CLI Reference

The plugin uses the `codex-agent` CLI under the hood:

```bash
codex-agent start "task" -r high --map -s read-only   # spawn
gcloud auth application-default login
gcloud config set project YOUR_PROJECT_ID
codex-agent start "Critique this UI flow" --provider gemini --model gemini-3-pro
codex-agent jobs --json                                # monitor
codex-agent capture <id>                               # check output
codex-agent send <id> "new instructions"               # redirect
codex-agent kill <id>                                  # stop (last resort)
```

See the [main README](../../README.md) for full CLI documentation.

## License

MIT
