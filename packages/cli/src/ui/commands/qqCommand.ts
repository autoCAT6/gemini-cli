/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from './types.js';
import type { HistoryItemWithoutId } from '../types.js';

/** Extract a human-readable message from a Gemini SDK error. */
function extractReadableMessage(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    const obj: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
    if (typeof obj !== 'object' || obj === null || !('error' in obj)) {
      return raw;
    }
    const { error } = obj as { error: unknown };
    if (typeof error !== 'object' || error === null || !('message' in error)) {
      return raw;
    }
    const { message } = error as { message: unknown };
    if (typeof message === 'string') {
      return message;
    }
  } catch {
    // Not JSON — use the raw message.
  }
  return raw;
}

/**
 * /qq <question>
 *
 * Asks the model a side question using the current conversation as context,
 * but does NOT add the exchange to the LLM's conversation history. The
 * question and answer are displayed in the UI only — the model's memory is
 * unchanged after the command completes.
 *
 * Inspired by Claude Code's /btw command.
 */
export const qqCommand: SlashCommand = {
  name: 'qq',
  description:
    'Ask a side question without adding it to the conversation context',
  kind: CommandKind.BUILT_IN,
  isSafeConcurrent: true,
  action: async (context, args) => {
    const question = args.trim();
    if (!question) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Usage: /qq <your question>',
      };
    }

    const client = context.services.config?.getGeminiClient();
    if (!client) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Client not initialized',
      };
    }

    context.ui.setPendingItem({
      type: 'info',
      text: `[qq] ${question}\n...`,
    });

    const controller = new AbortController();
    // Timeout after 30 seconds to avoid hanging indefinitely
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      let accumulated = '';
      let lastRender = 0;
      const RENDER_INTERVAL_MS = 100;
      let pendingFlush: ReturnType<typeof setTimeout> | null = null;

      const flushPending = (): void => {
        if (pendingFlush !== null) {
          clearTimeout(pendingFlush);
          pendingFlush = null;
        }
        lastRender = Date.now();
        context.ui.setPendingItem({
          type: 'info',
          text: `[qq] ${question}\n${accumulated}`,
        });
      };

      for await (const chunk of client.generateEphemeralStream(
        question,
        controller.signal,
      )) {
        accumulated += chunk;
        const now = Date.now();
        if (now - lastRender >= RENDER_INTERVAL_MS) {
          flushPending();
        } else if (pendingFlush === null) {
          // Schedule a trailing flush so the last chunk is always rendered.
          pendingFlush = setTimeout(
            flushPending,
            RENDER_INTERVAL_MS - (now - lastRender),
          );
        }
      }
      // Final flush to show the complete response.
      flushPending();
      context.ui.addItem(
        {
          type: 'info',
          text: `[qq] ${question}`,
          icon: '?',
          color: 'cyan',
        } as HistoryItemWithoutId,
        Date.now(),
      );
      context.ui.addItem(
        {
          type: 'info',
          text: accumulated || '(no response)',
          icon: ' ',
        } as HistoryItemWithoutId,
        Date.now() + 1,
      );
    } catch (e) {
      let msg: string;
      if (controller.signal.aborted && !controller.signal.reason) {
        msg = 'Timed out after 30s';
      } else if (e instanceof Error) {
        // The Gemini SDK sometimes stuffs the raw JSON response into
        // Error.message. Try to extract the human-readable part.
        msg = extractReadableMessage(e.message);
      } else {
        msg = String(e);
      }
      context.ui.addItem(
        {
          type: 'error',
          text: `[qq] failed: ${msg}`,
        },
        Date.now(),
      );
    } finally {
      clearTimeout(timeout);
      context.ui.setPendingItem(null);
    }
    return;
  },
};
