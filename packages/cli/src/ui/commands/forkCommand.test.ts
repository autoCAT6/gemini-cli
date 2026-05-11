/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { forkCommand } from './forkCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';

const mockFork = vi.fn();

function makeContext(forkReturn: string | null | undefined) {
  if (forkReturn === undefined) {
    // No agent context available
    return createMockCommandContext({
      services: { agentContext: undefined },
    });
  }

  mockFork.mockReturnValue(forkReturn);
  return createMockCommandContext({
    services: {
      agentContext: {
        geminiClient: {
          getChatRecordingService: () => ({
            fork: mockFork,
          }),
        },
        config: {},
      },
    },
  });
}

describe('forkCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('metadata', () => {
    it('has the correct name', () => {
      expect(forkCommand.name).toBe('fork');
    });

    it('is marked autoExecute', () => {
      expect(forkCommand.autoExecute).toBe(true);
    });
  });

  it('returns an error when agentContext is not available', () => {
    const context = makeContext(undefined);
    const result = forkCommand.action!(context, '');
    expect(result).toMatchObject({
      type: 'message',
      messageType: MessageType.ERROR,
    });
    expect(mockFork).not.toHaveBeenCalled();
  });

  it('returns an info message when there is nothing to fork', () => {
    const context = makeContext(null);
    const result = forkCommand.action!(context, '');
    expect(result).toMatchObject({
      type: 'message',
      messageType: MessageType.INFO,
    });
    expect(mockFork).toHaveBeenCalledOnce();
    expect((result as { content: string }).content).toContain(
      'Nothing to fork',
    );
  });

  it('returns a success message containing the short ID', () => {
    const context = makeContext('a1b2c3d4');
    const result = forkCommand.action!(context, '');

    expect(result).toMatchObject({
      type: 'message',
      messageType: MessageType.INFO,
    });
    expect(mockFork).toHaveBeenCalledOnce();
    const content = (result as { content: string }).content;
    expect(content).toContain('a1b2c3d4');
    expect(content).toContain('gemini --resume a1b2c3d4');
    expect(content).toContain('/resume');
  });
});
