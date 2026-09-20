import type {
  ConversationPersistence,
  DurableAnswerCommit,
  DurableAnswerStart,
  DurableTurnCommit,
} from './conversation.js';
import { ConversationStore } from './conversation-store.js';

/** Thin adapter keeps Conversation independent from the SQLite implementation. */
export class StoreConversationPersistence implements ConversationPersistence {
  constructor(private readonly store: ConversationStore, private readonly sessionId: string,
    private readonly clock: () => number = Date.now) {}

  commitUserTurn(input: DurableTurnCommit) {
    if (input.sessionId !== this.sessionId) throw new Error('Conversation persistence session mismatch');
    this.store.ensureTopic({ sessionId: input.sessionId, id: input.topicId, label: input.topicLabel, at: input.createdAt });
    return this.store.commitUserTurn({
      sessionId: input.sessionId,
      topicId: input.topicId,
      messageId: input.messageId,
      turnId: input.turnId,
      content: input.content,
      createdAt: input.createdAt,
      cognitiveMode: input.cognitiveMode,
      reasoningEffort: input.reasoningEffort,
      retryOfTurnId: input.retryOfTurnId,
    });
  }

  startAssistantAnswer(input: DurableAnswerStart) {
    if (input.sessionId !== this.sessionId) throw new Error('Conversation persistence session mismatch');
    return this.store.startAssistantAnswer(input);
  }

  checkpointAssistantAnswer(messageId: string, content: string, updatedAt = this.clock()) {
    this.store.checkpointAssistantAnswer({ messageId, content, updatedAt });
  }

  commitAssistantAnswer(input: DurableAnswerCommit) {
    return this.store.commitAssistantAnswer({
      messageId: input.messageId,
      content: input.content,
      citations: input.citations,
      updatedAt: input.updatedAt,
    });
  }

  interruptAssistantAnswer(turnId: string, updatedAt = this.clock(), reason = 'CONNECTION_INTERRUPTED') {
    return this.store.interruptAssistantAnswer({ turnId, updatedAt, reason });
  }
}
