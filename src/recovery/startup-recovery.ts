import type { StateStore } from "../state/state-store.js";

export interface RecoveryFeishuPort {
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  updateAnswerCard(cardId: string, content: string, sequence: number): Promise<void>;
  finishAnswerCard(cardId: string, content: string, sequence: number, status: string): Promise<void>;
}

export interface StartupRecoveryResult {
  staleRunCount: number;
  expiredApprovalCount: number;
  clearedReactionCount: number;
  errors: string[];
}

export async function recoverStartupState(input: {
  store: StateStore;
  feishu: RecoveryFeishuPort;
  now: number;
}): Promise<StartupRecoveryResult> {
  const stale = input.store.listStaleRunArtifacts();
  const reactions = input.store.listUnclearedReactions();
  const staleRunIds = input.store.failStaleRuns(input.now);
  const expiredApprovalCount = input.store.expirePendingApprovals(input.now);
  const errors: string[] = [];
  const sequence = Math.max(1_000, Math.floor(input.now / 1_000));

  for (const run of stale) {
    if (!run.cardId) continue;
    const content = "服务重启，本次任务已安全终止，未自动重放。请确认后重新发起。";
    try {
      await input.feishu.updateAnswerCard(run.cardId, content, sequence);
      await input.feishu.finishAnswerCard(run.cardId, content, sequence + 1, "failed");
    } catch {
      errors.push("card_recovery_failed");
    }
  }

  let clearedReactionCount = 0;
  for (const reaction of reactions) {
    try {
      await input.feishu.removeReaction(reaction.messageId, reaction.reactionId);
      input.store.clearReaction(reaction.messageId, input.now);
      clearedReactionCount += 1;
    } catch {
      errors.push("reaction_cleanup_failed");
    }
  }

  return {
    staleRunCount: staleRunIds.length,
    expiredApprovalCount,
    clearedReactionCount,
    errors,
  };
}
