/**
 * 只读探针：按 run 的 latestCheckpointRef.rootBlobId 解析 ConversationStateStructure
 * field 5（token_details）→ used/max。与产品路径 `src/checkpointContextUsage.ts` 同源，
 * 禁止 BFS 整棵 merkle（见 docs/checkpoint-context-usage.md / 决策·source-checkpoint）。
 *
 * 用法: npx tsx scripts/probe-checkpoint-token-details.ts <cwd>
 */
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";
import { extractContextUsageFromRoot } from "../src/checkpointContextUsage.js";

async function main(): Promise<void> {
  const cwd = process.argv[2];
  if (!cwd) {
    console.error("用法: npx tsx scripts/probe-checkpoint-token-details.ts <cwd>");
    process.exit(1);
  }

  const store = await SqliteLocalAgentStore.open({ workspaceRef: cwd });
  const { items: agents } = await store.agents.list({ filter: { cwd } });

  let runsWithCheckpoint = 0;
  let runsWithDetails = 0;
  let agentsWithCheckpoint = 0;
  let agentsWithDetails = 0;

  for (const agent of agents) {
    if (agent.latestCheckpoint?.rootBlobId) {
      agentsWithCheckpoint += 1;
      const data = await store.checkpoints.get({
        agentId: agent.agentId,
        blobId: agent.latestCheckpoint.rootBlobId,
      });
      if (data && extractContextUsageFromRoot(data)) agentsWithDetails += 1;
    }

    const { items: runs } = await store.runs.list({
      filter: { agentIds: [agent.agentId] },
    });
    for (const run of runs) {
      const rootBlobId = run.latestCheckpointRef?.rootBlobId;
      if (!rootBlobId) continue;
      runsWithCheckpoint += 1;
      const data = await store.checkpoints.get({
        agentId: agent.agentId,
        blobId: rootBlobId,
      });
      const usage = data ? extractContextUsageFromRoot(data) : null;
      if (!usage) continue;
      runsWithDetails += 1;
      const usageTotal = run.usage?.totalTokens;
      const pct = Math.round((usage.usedTokens / usage.maxTokens) * 100);
      console.log(
        [
          `status=${run.status}`,
          `model=${run.model?.id ?? "?"}`,
          `usageTotal=${usageTotal ?? "?"}`,
          `used=${usage.usedTokens}`,
          `max=${usage.maxTokens}`,
          `(~${pct}%)`,
          `runId=${run.runId}`,
        ].join("  "),
      );
    }
  }

  console.log("---");
  console.log(
    `agents(with checkpoint): ${agentsWithDetails}/${agentsWithCheckpoint} have token_details`,
  );
  console.log(
    `runs(with checkpoint): ${runsWithDetails}/${runsWithCheckpoint} have used+max` +
      (runsWithCheckpoint
        ? ` (hit rate ${(runsWithDetails / runsWithCheckpoint).toFixed(3)})`
        : ""),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
