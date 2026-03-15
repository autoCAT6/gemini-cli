# Side questions (`/qq`)

The `/qq` command lets you ask the model a question without adding the exchange
to your conversation history. Both your question and the model's answer appear
in the UI, but the model's memory is completely unchanged afterward — your
ongoing session continues exactly as if `/qq` had never been typed.

## Usage

```text
/qq <your question>
```

**Example:**

```text
/qq what does Array.flatMap do?
```

The question is displayed with a `?` indicator in cyan, followed immediately by
the model's answer. After the response, your next regular prompt picks up from
the same context as before.

## When to use it

`/qq` is useful any time you want a quick answer without polluting your working
context:

- **Mid-task lookups:** "btw, what's the difference between `==` and `===`?" —
  without the model treating that as part of your refactoring task.
- **Syntax checks:** Quickly verify an API signature or flag without derailing a
  longer conversation.
- **Concurrent queries:** Because `/qq` is safe to run while the model is still
  responding to another prompt, you can ask a follow-up before the current
  answer finishes streaming.

## How it works

Unlike a normal prompt, `/qq` calls the model via a streaming
`generateContentStream` request that includes the current conversation as
read-only context. The answer streams into the UI progressively as chunks arrive
— `GeminiChat.history` is never modified. When the stream completes (or fails,
or times out after 30 seconds), the session state is byte-for-byte identical to
what it was before.

## Limitations

- `/qq` uses the same model and API key as your main session; it counts against
  your quota.
- The model sees your conversation as context but cannot act on it (no tool
  calls, no file edits).
- Answers are not saved to the session file and will not appear if you resume
  the session later.
