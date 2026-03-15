# CC → GCLI Feature Gap: `/qq` and `/fork`

This document covers the design, implementation, and architecture interactions
of two Claude Code features backported to the open-source Gemini CLI.

---

## Overview

| Feature | CC equivalent | Status         |
| ------- | ------------- | -------------- |
| `/qq`   | `/btw`        | ✅ Implemented |
| `/fork` | `/fork`       | ✅ Implemented |

Both ship as built-in slash commands registered in
`packages/cli/src/services/BuiltinCommandLoader.ts`.

---

## Feature 1: `/qq` — Ephemeral side questions

### What CC's `/btw` does

`/btw <question>` is one of Claude Code's most-discussed UX additions. It lets
you ask a quick clarifying question — "what does this config key do?", "what was
the name of that file?" — while keeping the main conversation context completely
clean. The core contract:

- **Full session context visible to the model** — it can see everything you've
  discussed so far this session.
- **No tools, no file access, no actions** — the model answers from memory only.
  It cannot read new files, run commands, or call any tools.
- **One-shot** — a single response, no follow-up turns.
- **Ephemeral display** — CC shows the answer as a temporary overlay; dismissing
  it (Space / Enter / Escape) removes it from the screen entirely.
- **Never enters history** — neither the question nor the answer appears in the
  LLM context for any subsequent turn.
- **Concurrent** — you can type `/btw` while CC is mid-response on a long task;
  it runs independently without interrupting the main turn.
- **Cost-efficient** — the query reuses the parent conversation's prompt cache,
  adding only a tiny amount of new tokens.

The mental model: a subagent starts with no context but has full tools; `/btw`
is the inverse — it has full context but zero tools.

### The gap in GCLI

GCLI has no equivalent. Every typed prompt flows through `useGeminiStream` →
`prepareQueryForGemini` → `geminiClient.sendMessageStream()`, which always
appends to `GeminiChat.history`. There is no way to query the model without
permanently extending the LLM context.

### What `/qq` does in GCLI

`/qq <question>` is the GCLI equivalent. The same contract applies:

- Answers from existing session context; never adds to `GeminiChat.history`
- Text-only context passed to the model — no tool declarations
- Single-turn response
- Shown in the UI with a `?` / cyan header; remains in the terminal scroll
  buffer (unlike CC's dismissable overlay, which GCLI's ink-based UI cannot
  replicate directly)
- `isSafeConcurrent: true` — can be issued while the model is streaming

One intentional divergence from CC: `/qq` answers stay in the terminal scroll
buffer rather than disappearing, which is more natural for a non-overlay TUI.

### How `/qq` interacts with GCLI's existing design

#### Two history stores

GCLI keeps two independent history stores:

| Store       | Location                                                                | Purpose                                             |
| ----------- | ----------------------------------------------------------------------- | --------------------------------------------------- |
| LLM context | `GeminiChat.history` in `packages/core/src/core/geminiChat.ts`          | Sent to the model on every `sendMessageStream` turn |
| UI display  | `useHistoryManager` in `packages/cli/src/ui/hooks/useHistoryManager.ts` | What the user sees on screen                        |

The normal message flow (`useGeminiStream.ts`) writes to both: the model
response is appended to `GeminiChat.history` (via `getChat().addHistory()`) and
the UI items are added via `useHistoryManager.addItem`. `/qq` breaks this
coupling on purpose — it writes to the UI history but **never touches**
`GeminiChat.history`.

#### `generateContentStream` vs `sendMessageStream`

The normal flow uses `geminiClient.sendMessageStream()` →
`getChat().sendMessageStream()`, which is a stateful method that appends to
`this.history` as a side effect.

`generateEphemeralStream` instead calls `generateContentStream()` on the content
generator directly — a lower-level streaming API that takes an explicit
`Content[]` array and has **no side effects on `this.chat.history`**. It returns
an async generator that yields text chunks as they arrive from the API, giving
the user immediate visual feedback. No save/restore snapshot is needed; the
history is simply never touched.

```
Normal turn:
  sendMessageStream(msg)
    → getChat().sendMessageStream()   ← mutates this.history
    → response chunks streamed to UI

/qq turn:
  generateEphemeralStream(question)
    → buildTextOnlyHistory()              ← read-only, no mutation
    → generateContentStream(contents)     ← streaming API call, no history side effect
    → yields text chunks → UI updates progressively
```

#### The functionCall stripping fix

`getHistory(true)` calls `extractCuratedHistory()`, which filters out empty or
safety-filtered turns but **does not strip `functionCall` / `functionResponse`
parts**. After any tool use in a session, the curated history contains turns
like:

```json
{ "role": "model", "parts": [{ "functionCall": { "name": "read_file", ... } }] }
{ "role": "user",  "parts": [{ "functionResponse": { "name": "read_file", ... } }] }
```

When these are passed to `generateContent` without matching tool declarations,
the Gemini API returns a 400. The fix in `generateEphemeralStream`:

```typescript
const textOnlyHistory = curatedHistory
  .map((content) => ({
    ...content,
    parts: (content.parts ?? []).filter((p) => p.text !== undefined),
  }))
  .filter((content) => content.parts.length > 0);
```

This keeps only text (and thought) parts, dropping function call/response turns
entirely — matching `/btw`'s text-context-only contract.

#### Slash command registration

`/qq` is registered as a `SlashCommand` object in `BuiltinCommandLoader.ts`. The
command parser in `slashCommandProcessor.ts` intercepts `/qq <args>` before it
reaches `useGeminiStream`, so the question is never sent through the normal turn
pipeline.

```
User types: /qq what does flatMap do?
  → slashCommandProcessor identifies 'qq'
  → qqCommand.action(context, 'what does flatMap do?') called
  → generateEphemeralStream() called
  → GeminiChat.history: unchanged
  → UI: pending item updates with streamed chunks, then final items added
```

### Limitations

- Uses the same model and API key as the main session; counts against quota.
- Answers are not persisted — they will not appear if the session is resumed.
- The model cannot take any action (no tools, no file reads) — it answers from
  conversation context only.
- 30-second timeout; if the API doesn't respond in time, the command aborts.

---

## Feature 2: `/fork` — Branch into a new independent session

### What CC's `/fork` does

`/fork` creates an independent copy of the current conversation and opens it in
a new terminal window. Both windows continue running independently from the same
point. Key properties:

- **Non-destructive** — the original session is unaffected.
- **Full fidelity** — the fork contains the complete conversation history,
  including all tool call results and file reads already in context.
- **Independently resumable** — either session can be closed and resumed later.
- **Use case:** "I want to try a completely different approach from here without
  losing where I am."

### The gap in GCLI

GCLI has `/rewind` (destructive rollback — removes turns from the current
session) and session management (`/chat`, `--resume`), but no way to branch
forward non-destructively. Once you start going a different direction, there is
no way to return to the previous state without losing work.

### What `/fork` does in GCLI

`/fork` saves a snapshot of the current `ConversationRecord` to a new session
file. Both the original and the fork are independently resumable via `--resume`
or `/chat`.

```text
/fork
→ Fork saved (a1b2c3d4).
  Resume with: gemini --resume a1b2c3d4
  Or browse sessions with: /chat
```

The command prints the short ID and resume instructions. Opening a new terminal
window automatically is not yet implemented (that requires platform-specific
shell spawning and is left as a future improvement).

### How `/fork` interacts with GCLI's existing design

#### Session storage

GCLI persists conversations as JSON files in:

```
~/.gemini/tmp/<project_hash>/chats/<sessionId>.json
```

The `<project_hash>` is derived by `projectRegistry.ts` from the working
directory path. The `<sessionId>` is the filename stem (without `.json`).

Any file placed in this directory is automatically discoverable by `/chat` and
resumable via `gemini --resume <sessionId>`.

#### `ConversationRecord` and `ChatRecordingService`

The recording service (`packages/core/src/services/chatRecordingService.ts`)
maintains a live `ConversationRecord` — a typed snapshot of the full session
including all messages, metadata, and timestamps.

`/fork` reads this record via:

```typescript
client.getChatRecordingService().getConversation();
```

It then shallow-copies it with a new `sessionId` and writes it to the chats
directory. The existing write path (same JSON schema) ensures the fork is
immediately recognized by all other session commands.

```
Current session:   ~/.gemini/tmp/<hash>/chats/main-session.json
                   ↓  /fork
Forked session:    ~/.gemini/tmp/<hash>/chats/session-<ts>-<shortId>.json
                   (identical content, new sessionId + timestamps)
```

#### No changes to `packages/core`

`/fork` is a pure CLI command. The entire implementation lives in
`packages/cli/src/ui/commands/forkCommand.ts`. It uses only public APIs
(`getChatRecordingService`, `config.storage.getProjectTempDir`) that were
already exposed — no new core methods were needed.

#### Relationship to other session commands

| Command         | Effect on history                                              |
| --------------- | -------------------------------------------------------------- |
| `/rewind`       | Destructively removes turns from the **current** session       |
| `/fork`         | Non-destructively branches into a **new** independent session  |
| `--resume <id>` | Loads an existing session (including forks) into a new process |
| `/chat`         | Session browser — forked sessions appear here                  |

`/fork` + `/rewind` compose naturally: fork to preserve the current state, then
rewind to go back and try something different.

#### Why `/fork` instead of `--resume` in a second terminal

GCLI's `--resume` was designed for **sequential** use — close a session, resume
it later. It was not designed for **concurrent** use. When two terminals resume
the same session ID, both processes point at the **same JSON file** on disk:

- Each process maintains its own in-memory `ChatRecordingService` cache.
- Each process writes the full session JSON via `fs.writeFileSync()` after every
  turn — there is **no file locking, no mutex, no atomic write**.
- **Last-write-wins**: whichever terminal writes last silently overwrites the
  other's messages. The persisted file ends up with an inconsistent mix of
  turns.

|                  | `/fork` then `--resume <fork_id>`    | `--resume <original_id>` directly         |
| ---------------- | ------------------------------------ | ----------------------------------------- |
| Session files    | Two separate files, two separate IDs | Same file, same ID                        |
| Write conflicts  | None — fully independent             | Last-write-wins, messages silently lost   |
| Original session | Unaffected                           | Corrupted on disk by interleaved writes   |
| Mental model     | Git branch                           | Two editors opening the same unsaved file |

`/fork` solves this by creating a **new file** with a **new session ID** before
you branch. Both sessions are fully independent — no write conflicts, no data
loss.

---

## Tests

Each new code path has unit tests following the project's vitest conventions.

| File                                                                                     | What's covered                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/ui/commands/qqCommand.test.ts`                                         | Missing question → error; no client → error; streaming happy path (pending item updated progressively, question header + answer added to UI); empty stream → `"(no response)"`; stream throw → error item + pending cleared |
| `packages/cli/src/ui/commands/forkCommand.test.ts`                                       | No config → error; empty/null conversation → info, no write; writes `chats/` dir + file; written JSON has new `sessionId` and preserves messages; short ID appears in success message                                       |
| `packages/core/src/core/client.test.ts` (added `generateEphemeralStream` describe block) | Streams text chunks; does not mutate `GeminiChat.history`; strips `functionCall`/`functionResponse` parts; drops tool-only turns entirely; empty stream → no chunks yielded                                                 |

Run commands:

```bash
# Command tests
cd /Users/yanzhi/cli-gaps/packages/cli
~/.nvm/versions/node/v22.22.1/bin/node ../../node_modules/.bin/vitest run \
  src/ui/commands/qqCommand.test.ts src/ui/commands/forkCommand.test.ts

# Core client tests (includes generateEphemeral)
cd /Users/yanzhi/cli-gaps/packages/core
~/.nvm/versions/node/v22.22.1/bin/node ../../node_modules/.bin/vitest run src/core/client.test.ts

# Full preflight before PR
export PATH=~/.nvm/versions/node/v22.22.1/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH
npm run preflight
```

---

## Files changed

| File                                                | Change                                                                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/core/client.ts`                  | Added `generateEphemeralStream()`; fixed `LlmRole` import; strips `functionCall`/`functionResponse` parts; uses streaming API |
| `packages/cli/src/ui/commands/qqCommand.ts`         | New — `/qq` command                                                                                                           |
| `packages/cli/src/ui/commands/forkCommand.ts`       | New — `/fork` command                                                                                                         |
| `packages/cli/src/services/BuiltinCommandLoader.ts` | Registered both commands                                                                                                      |
| `packages/core/src/core/client.test.ts`             | Added `generateEphemeralStream` test block (5 tests)                                                                          |
| `packages/cli/src/ui/commands/qqCommand.test.ts`    | New — 7 tests                                                                                                                 |
| `packages/cli/src/ui/commands/forkCommand.test.ts`  | New — 8 tests                                                                                                                 |
| `docs/cli/qq.md`                                    | New — user-facing docs for `/qq`                                                                                              |
| `docs/cli/fork.md`                                  | New — user-facing docs for `/fork`                                                                                            |

---

## Contribution notes (per CLAUDE.md)

- Open a GitHub issue for each feature before submitting a PR; wait for
  `help-wanted` label
- One feature per PR
- Run `npm run preflight` before opening a PR
- Sign Google CLA at https://cla.developers.google.com/ before first PR
- Commit style: `feat(cli): add /qq command for ephemeral side questions`
