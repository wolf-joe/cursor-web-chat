import {
  Agent,
  type ConversationTurn,
  type AgentMessage,
  type ModelSelection,
  type TokenUsage,
  type RunStatus,
} from "@cursor/sdk";
import { listAgentRuns, getLocalStore } from "./agentService.js";
import {
  checkpointAdvanced,
  extractUserTextFromCheckpointDiff,
} from "./checkpointUserText.js";
import {
  readContextUsageFromCheckpoint,
  type ContextUsage,
} from "./checkpointContextUsage.js";
import { hasUserImage, userImageUrl } from "./userImageStore.js";

export interface RunTurns {
  runId: string;
  createdAt?: number;
  // run 级别的模型/用量(§Run.model, §Run.usage),粒度是"一次用户提问+完整应答",
  // 不对应单条消息——和 createdAt 挂在 run 上的道理一样(见 CLAUDE.md)。
  model?: ModelSelection;
  usage?: TokenUsage;
  // 决策·api-shape / 决策·source-checkpoint: 窗口占用(used/max),与计费 usage 并存不混用。
  // 缺 checkpoint / field 5 / 解析失败则省略(决策·parse-degrade)。
  contextUsage?: ContextUsage;
  /** finished 省略也行;已推进的 cancelled/error 带上,供前端诚实标状态。 */
  status?: RunStatus;
  // 决策·side-store-by-runId: 旁路有图时带 URL,避免历史每轮盲打 GET 404。
  userImageUrl?: string;
  turns: ConversationTurn[];
}

export type ConversationHistory =
  | { mode: "conversation"; runs: RunTurns[] }
  | { mode: "fallback"; messages: AgentMessage[] };

const USER_TEXT_PLACEHOLDER = "（未能还原用户原文）";

// 决策·history-source: 优先用 listRuns + run.conversation() 取富历史(含
// thinking/工具调用)。若任意 run 不支持 conversation() (未决·conversation-support),
// 整体降级为 messages.list 的纯文本历史,而不是部分 run 富、部分 run 纯文本的混合展示。
export async function getConversationHistory(
  agentId: string,
  cwd: string,
): Promise<ConversationHistory> {
  const runs = await listAgentRuns(agentId, cwd);
  const sorted = [...runs].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

  const store = await getLocalStore(cwd);
  const { items: runDocs } = await store.runs.list({ filter: { agentIds: [agentId] } });
  const runDocById = new Map(runDocs.map((d) => [d.runId, d]));

  const runTurns: RunTurns[] = [];
  /** 已推进的非 finished:blob 捞 user 作 messages.list 未配上时的备选。 */
  const advancedNonFinished: {
    rt: RunTurns;
    startRoot: string | null | undefined;
    latestRoot: string | null | undefined;
  }[] = [];

  for (const run of sorted) {
    if (!run.supports("conversation")) {
      const messages = await Agent.messages.list(agentId, { runtime: "local", cwd });
      return { mode: "fallback", messages };
    }

    const doc = runDocById.get(run.id);
    const startRoot = doc?.startCheckpointRef?.rootBlobId;
    const latestRoot = doc?.latestCheckpointRef?.rootBlobId;
    const advanced = checkpointAdvanced(startRoot, latestRoot);

    // 决策·checkpoint-advanced-gate / 决策·cancelled-turn-drop:
    // 旧注释「非 finished 永不推进 checkpoint、messages.list 也永无该轮 user」不完整——
    // 已推进的 cancelled/error 会进模型上下文,且 messages.list 里也会有对应 user。
    // 未推进的(早停 start==latest)仍整轮剔除,绝不能进按位配对。
    // 决策·error-same-gate: error 与 cancelled 共用推进闸门。
    if (run.status === "finished") {
      const turns = await run.conversation();
      // 决策·per-run-checkpoint: 用该 run 的 end checkpoint,禁止 agent.latestCheckpoint 回填。
      const contextUsage =
        (await readContextUsageFromCheckpoint(store, agentId, latestRoot)) ?? undefined;
      runTurns.push({
        runId: run.id,
        createdAt: run.createdAt,
        model: run.model,
        usage: run.usage,
        contextUsage,
        status: "finished",
        ...(hasUserImage(run.id) ? { userImageUrl: userImageUrl(run.id) } : {}),
        turns,
      });
      continue;
    }

    if ((run.status === "cancelled" || run.status === "error") && advanced) {
      // 决策·cancelled-conversation: 已推进时 conversation() 返回半截 steps。
      let turns = await run.conversation();
      if (turns.length === 0) {
        turns = [
          {
            type: "agentConversationTurn",
            turn: { steps: [] },
          },
        ];
      }
      const contextUsage =
        (await readContextUsageFromCheckpoint(store, agentId, latestRoot)) ?? undefined;
      const rt: RunTurns = {
        runId: run.id,
        createdAt: run.createdAt,
        model: run.model,
        usage: run.usage,
        contextUsage,
        status: run.status,
        ...(hasUserImage(run.id) ? { userImageUrl: userImageUrl(run.id) } : {}),
        turns,
      };
      runTurns.push(rt);
      advancedNonFinished.push({ rt, startRoot, latestRoot });
      continue;
    }

    // 未推进的 cancelled/error/expired/running 等:不展示。
  }

  // 决策·finished-backfill-untouched(修正): messages.list 的 user 与「checkpoint
  // 已推进」的轮次按序一一对应——含已推进的 cancelled/error,不只 finished。
  // 若只拿 finished 去配,已推进取消轮的 user 会把后面 finished 全部错位一格
  // (案发 Pranks 取消后,Proxy 轮会被安上 Pranks 原文)。未推进取消仍不在此列。
  // conversation() 的 userMessage 在 local 下始终缺失,只借 messages.list 补 text。
  await backfillUserMessages(agentId, cwd, runTurns);

  // 决策·user-text-from-blobs: messages.list 未配上时,再从 checkpoint blob 差分捞;
  // 仍没有则占位(决策·blob-parse-degrade),不拖垮整页。
  for (const { rt, startRoot, latestRoot } of advancedNonFinished) {
    if (!hasUnresolvedUserMessage(rt)) continue;
    const text = await extractUserTextFromCheckpointDiff(
      store,
      agentId,
      startRoot,
      latestRoot,
    );
    fillMissingUserMessages(rt, text ?? USER_TEXT_PLACEHOLDER);
  }

  // finished:没配上 user 则整轮丢弃。已推进非 finished:已用 blob/占位填过,保留。
  const complete = runTurns.filter((rt) => {
    if (rt.status && rt.status !== "finished") return true;
    return !hasUnresolvedUserMessage(rt);
  });

  return { mode: "conversation", runs: complete };
}

function fillMissingUserMessages(rt: RunTurns, text: string): void {
  for (const turn of rt.turns) {
    if (turn.type !== "agentConversationTurn") continue;
    if (!turn.turn.userMessage) {
      turn.turn.userMessage = { text };
    }
  }
}

function hasUnresolvedUserMessage(rt: RunTurns): boolean {
  return rt.turns.some((t) => t.type === "agentConversationTurn" && !t.turn.userMessage);
}

// messages.list() 的原始载荷是 protobuf-es 的 oneof 包装:
// message.turn = { case: "agentConversationTurn", value: { userMessage, steps } }
// (JSON.stringify 会把它序列化成 { agentConversationTurn: {...} } 这种更好看的形式,
// 但直接访问 JS 对象拿到的是 { case, value } 这层,两者不是一回事,取值时要认 case/value。)
function extractUserText(raw: unknown): string | undefined {
  const turn = (raw as { turn?: { case?: string; value?: { userMessage?: { text?: unknown } } } } | undefined)
    ?.turn;
  if (turn?.case !== "agentConversationTurn") return undefined;
  const text = turn.value?.userMessage?.text;
  return typeof text === "string" ? text : undefined;
}

async function backfillUserMessages(
  agentId: string,
  cwd: string,
  runTurns: RunTurns[],
): Promise<void> {
  if (runTurns.length === 0) return;
  const messages = await Agent.messages.list(agentId, { runtime: "local", cwd });
  const userTexts = messages
    .filter((m) => m.type === "user")
    .map((m) => extractUserText(m.message));

  // messages.list 第 i 条 user ↔ 按时间排序后第 i 个「已推进」agentConversationTurn
  // (含已推进 cancelled/error;不含早停未推进轮)。
  let i = 0;
  for (const rt of runTurns) {
    for (const turn of rt.turns) {
      if (turn.type !== "agentConversationTurn") continue;
      if (!turn.turn.userMessage) {
        const text = userTexts[i];
        if (text) turn.turn.userMessage = { text };
      }
      i += 1;
    }
  }
}
