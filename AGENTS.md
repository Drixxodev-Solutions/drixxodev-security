# AGENTS.md

This project's shared rules — vision, architecture, security, cost controls, conventions, and environment — live in [CLAUDE.md](CLAUDE.md). Read it fully before writing any code. **Every agent must obey its §2 (core principle) and §7 (security rules).**

Role-specific instructions live in one file per role:

- `frontend` — [.claude/agents/frontend.md](.claude/agents/frontend.md)
- `backend` — [.claude/agents/backend.md](.claude/agents/backend.md)
- `qa` — [.claude/agents/qa.md](.claude/agents/qa.md)
- `testing` — [.claude/agents/testing.md](.claude/agents/testing.md)
- `github` — [.claude/agents/github.md](.claude/agents/github.md)

In Claude Code these files are invokable subagents. In Cursor the same guidance auto-activates via the rules under `.cursor/rules/` (scoped to the files you're editing).
