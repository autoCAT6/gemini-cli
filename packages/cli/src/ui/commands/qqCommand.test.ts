/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { qqCommand } from './qqCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { GeminiClient } from '@google/gemini-cli-core';
import { MessageType } from '../types.js';

/** Helper: create an async generator that yields the given chunks. */
async function* fakeStream(...chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) {
    yield c;
  }
}

/** Helper: create an async iterable that throws on first iteration. */
function throwingStream(error: Error): AsyncGenerator<string> {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      throw error;
    },
    async return() {
      return { done: true, value: undefined };
    },
    async throw(e: unknown) {
      throw e;
    },
  } as AsyncGenerator<string>;
}

describe('qqCommand', () => {
  let context: ReturnType<typeof createMockCommandContext>;
  let mockGenerateEphemeralStream: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGenerateEphemeralStream = vi.fn();
    context = createMockCommandContext({
      services: {
        config: {
          getGeminiClient: () =>
            ({
              generateEphemeralStream: mockGenerateEphemeralStream,
            }) as unknown as GeminiClient,
        },
      },
    });
  });

  describe('metadata', () => {
    it('has the correct name', () => {
      expect(qqCommand.name).toBe('qq');
    });

    it('is marked isSafeConcurrent', () => {
      expect(qqCommand.isSafeConcurrent).toBe(true);
    });
  });

  it('returns an error when called with no question', async () => {
    const result = await qqCommand.action!(context, '   ');
    expect(result).toMatchObject({
      type: 'message',
      messageType: MessageType.ERROR,
    });
    expect(mockGenerateEphemeralStream).not.toHaveBeenCalled();
  });

  it('returns an error when client is not initialized', async () => {
    const noClientContext = createMockCommandContext({
      services: { config: null },
    });
    const result = await qqCommand.action!(noClientContext, 'what is 2+2?');
    expect(result).toMatchObject({
      type: 'message',
      messageType: MessageType.ERROR,
    });
  });

  it('streams chunks into pending item then adds final question + answer items', async () => {
    mockGenerateEphemeralStream.mockReturnValue(fakeStream('fo', 'ur'));

    await qqCommand.action!(context, 'what is 2+2?');

    // generateEphemeralStream called with the question
    expect(mockGenerateEphemeralStream).toHaveBeenCalledWith(
      'what is 2+2?',
      expect.any(AbortSignal),
    );

    // Pending item updated progressively as chunks arrive
    expect(context.ui.setPendingItem).toHaveBeenCalledWith(
      expect.objectContaining({ text: '[qq] what is 2+2?\nfo' }),
    );
    expect(context.ui.setPendingItem).toHaveBeenCalledWith(
      expect.objectContaining({ text: '[qq] what is 2+2?\nfour' }),
    );

    // Two final UI items: question header + full answer
    expect(context.ui.addItem).toHaveBeenCalledTimes(2);
    expect(context.ui.addItem).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: '[qq] what is 2+2?', icon: '?' }),
      expect.any(Number),
    );
    expect(context.ui.addItem).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: 'four' }),
      expect.any(Number),
    );

    // Pending item cleared in finally
    expect(context.ui.setPendingItem).toHaveBeenLastCalledWith(null);
  });

  it('shows "(no response)" when stream yields nothing', async () => {
    mockGenerateEphemeralStream.mockReturnValue(fakeStream());

    await qqCommand.action!(context, 'hello?');

    expect(context.ui.addItem).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: '(no response)' }),
      expect.any(Number),
    );
  });

  it('adds an error item and clears pending when stream throws', async () => {
    mockGenerateEphemeralStream.mockReturnValue(
      throwingStream(new Error('API failure')),
    );

    await qqCommand.action!(context, 'will it fail?');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: expect.stringContaining('API failure'),
      }),
      expect.any(Number),
    );
    // finally must always clear pending
    expect(context.ui.setPendingItem).toHaveBeenLastCalledWith(null);
  });
});
