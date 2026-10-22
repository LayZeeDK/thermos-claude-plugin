# thermos-claude-plugin

A Claude Code plugin marketplace hosting **Thermos** -- a Claude Code port of Cursor's official Thermos branch-review plugin.

## Install

```bash
/plugin marketplace add LayZeeDK/thermos-claude-plugin
/plugin install thermos@thermos-claude-plugin
```

The plugin lives in [`plugins/thermos/`](plugins/thermos/) -- see its [README](plugins/thermos/README.md) for skills, agents, architecture, and usage.

The marketplace also hosts **Thermos Experimental**, opt-in variants of the Thermos review built to be measured against `/thermos`. It stays at version `0.x.y`, and any release can rename or remove an entry point. See its [README](plugins/thermos-experimental/README.md).

```bash
/plugin install thermos-experimental@thermos-claude-plugin
```

## License

MIT -- see [`plugins/thermos/LICENSE`](plugins/thermos/LICENSE). This is a port of Cursor's Thermos plugin; the license names both Cursor (original) and the porter.
