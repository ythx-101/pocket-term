# Claude Code JSONL transcript format (observed)

Structure notes only — no session content. Observed under `~/.claude/projects/<slug>/*.jsonl`.

- **Framing**: one JSON object per line; grow-only append; partial last line possible while writing.
- **Chat turns**:
  - `type:"user"` — `message.content` is a string (prompt) or array of blocks (`text`, `tool_result`, …). `isMeta:true` = internal, not chat.
  - `type:"assistant"` — `message.content` is an array of blocks: `text`, `tool_use`, `thinking` (and occasionally `image`).
- **Tool loop**: assistant `tool_use` `{id,name,input}` → following user line(s) with `tool_result` `{tool_use_id,content}` (not user speech).
- **Bookkeeping (skip for bubbles)**: `mode`, `permission-mode`, `ai-title`, `last-prompt`, `attachment`, `queue-operation`, `file-history-snapshot`, `file-history-delta`, `system` (API/meta notices).
- **Common fields**: `uuid`, `parentUuid`, `timestamp` (ISO), `sessionId`, `cwd`, `version`, `gitBranch`.
- **Tool input shapes seen**: `Read/Write/Edit.file_path`, `Bash.command`+`description`, `Skill.skill`, `Agent.description`.
- **Tier A mapping**: user string/text → `role:user`; assistant `text` → `role:agent`; `tool_use` → `role:system kind:tool`; everything else skipped.
- **Incremental read**: track byte offset after last `\n`; leave unterminated tail for the next read.
