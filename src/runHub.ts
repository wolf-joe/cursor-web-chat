import type { Run, SDKMessage, ModelSelection, TokenUsage } from "@cursor/sdk";
import { clearBusy, getLocalStore } from "./agentService.js";
import {
  readContextUsageFromCheckpoint,
  type ContextUsage,
} from "./checkpointContextUsage.js";
import { log } from "./logger.js";

export interface RunDoneEvent {
  type: "done";
  status: string;
  model?: ModelSelection;
  usage?: TokenUsage;
  // 决策·api-shape: 与 history 同源字段;缺则省略(决策·parse-degrade / 决策·done-race)。
  contextUsage?: ContextUsage;
  error?: string;
}

// 决策·attach-user-text: 用户文本单独作为 attach 事件在接入瞬间补发一次,
// 不依赖从事件流里重放出来(local 运行时下 run 的事件流里本就不含用户文本)。
// 整轮事件本身的重放另见 决策·replay-backlog。
// 决策·attach-image-url: 旁路缩略图 URL(禁止把 base64 塞进 SSE);无图时省略字段。
export interface RunAttachEvent {
  type: "attach";
  agentId: string;
  userText: string;
  imageUrl?: string;
}

export interface RunTitleEvent {
  type: "title";
  agentId: string;
  title: string;
}

export type HubEvent = SDKMessage | RunDoneEvent | RunAttachEvent | RunTitleEvent;

type Listener = (event: HubEvent) => void;

interface LiveRun {
  agentId: string;
  // 决策·store-reuse: done 时按 cwd 打开同一份 LocalAgentStore 读该 run 的 end checkpoint。
  cwd: string;
  run: Run;
  userText: string;
  imageUrl?: string;
  subscribers: Set<Listener>;
  // 决策·replay-backlog: 缓存这次 run 从开始到现在广播过的全部事件(done 除外,
  // 单独存 doneEvent)。新接入方(含刷新页面重连)先补发 attach,再原样重放这份
  // 缓存补全断连前已经发生的 thinking/工具调用,最后才挂上 subscribers 接后续实时事件——
  // 不再是"只广播从当下起的尾巴"。单进程内存缓存,run 结束后连同 LiveRun 一起在
  // 宽限期后被回收,不持久化、不考虑跨进程重启。
  events: HubEvent[];
  doneEvent?: RunDoneEvent;
}

// 决策·hub-owns-lifecycle: run 的消费循环脱离任何 HTTP 请求独立跑在这里,
// 请求只是订阅/退订这份广播——不再是 run 生命周期的宿主。
const liveRuns = new Map<string, LiveRun>();

// 决策·terminal-grace: run 到终态后,给"刚好在这个时间点前后接入"的客户端留一段
// 时间窗口,LiveRun(含它缓存的 events,见 决策·replay-backlog)不立即销毁——
// 接入者总能收到完整的事件重放 + 一个明确的终止信号,而不是被当成
// "这个 agent 从未直播过"。
const TERMINAL_GRACE_MS = 5000;

export function startRun(
  agentId: string,
  run: Run,
  userText: string,
  cwd: string,
  imageUrl?: string,
): void {
  const live: LiveRun = {
    agentId,
    cwd,
    run,
    userText,
    imageUrl,
    subscribers: new Set(),
    events: [],
  };
  liveRuns.set(agentId, live);
  // 决策·log-density: 开始消费不再打 info(与「聊天 run 已建立」重复);终态仍打。
  void consume(live);
}

async function loadDoneContextUsage(live: LiveRun): Promise<ContextUsage | undefined> {
  // 决策·source-checkpoint / 决策·per-run-checkpoint: 读该 live run 的 end checkpoint;
  // 决策·done-race: 若此时尚未写入最终 token_details 则省略,依赖随后 refetch。
  // 决策·no-usage-fallback: 绝不拿 run.usage 冒充。
  try {
    const store = await getLocalStore(live.cwd);
    const doc = await store.runs.get({ agentId: live.agentId, runId: live.run.id });
    const rootBlobId = doc?.latestCheckpointRef?.rootBlobId;
    return (await readContextUsageFromCheckpoint(store, live.agentId, rootBlobId)) ?? undefined;
  } catch {
    return undefined;
  }
}

async function consume(live: LiveRun): Promise<void> {
  const startedAt = Date.now();
  try {
    for await (const event of live.run.stream()) {
      // 决策·log-terminal-status: ERROR/CANCELLED/EXPIRED 的 status 事件带
      // message(如 Connection failed repeatedly),stream 正常走完分支也可能只落
      // 在 run.error 上——两边都记,避免只靠终态一条 info 丢原因。RUNNING/
      // FINISHED 仍不打,避免刷屏。
      if (event.type === "status") {
        const terminal =
          event.status === "ERROR" ||
          event.status === "CANCELLED" ||
          event.status === "EXPIRED";
        if (terminal) {
          log.warn("run status 事件", {
            agentId: live.agentId,
            runId: live.run.id,
            requestId: live.run.requestId,
            status: event.status,
            message: event.message,
          });
        }
      }
      broadcast(live, event);
    }
    // 决策·done-error-message: stream 正常走完但 status=error 时,错误文案在
    // run.error 上(status 事件的 message 同源);catch 路径另见下方。前端靠这个
    // 字段画错误条——缺了就只剩泛化的「运行出错」。
    const contextUsage = await loadDoneContextUsage(live);
    const done: RunDoneEvent = {
      type: "done",
      status: live.run.status,
      model: live.run.model,
      usage: live.run.usage,
      contextUsage,
      error: live.run.error?.message,
    };
    broadcast(live, done);
    // 决策·log-run-terminal: finished 仍 info;error/cancelled 升 warn/error,并带上
    // run.error(message/code)与 requestId——此前只打 status 字段,排查 Connection
    // failed repeatedly 时日志里看不到 UI/SQLite 已有的文案。
    const terminalCtx = {
      agentId: live.agentId,
      runId: live.run.id,
      requestId: live.run.requestId,
      status: done.status,
      durationMs: Date.now() - startedAt,
      model: done.model,
      usage: done.usage,
      contextUsage: done.contextUsage,
      error: done.error,
      errorCode: live.run.error?.code,
    };
    if (done.status === "error") {
      log.error("run 以 error 结束", undefined, terminalCtx);
    } else if (done.status === "cancelled") {
      log.warn("run 已取消", terminalCtx);
    } else {
      log.info("run 正常结束", terminalCtx);
    }
  } catch (err) {
    log.error("run stream 异常", err, {
      agentId: live.agentId,
      runId: live.run.id,
      requestId: live.run.requestId,
      durationMs: Date.now() - startedAt,
    });
    broadcast(live, {
      type: "done",
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearBusy(live.agentId);
    setTimeout(() => liveRuns.delete(live.agentId), TERMINAL_GRACE_MS).unref();
  }
}

function broadcast(live: LiveRun, event: HubEvent): void {
  if (event.type === "done") live.doneEvent = event;
  else live.events.push(event);
  for (const listener of live.subscribers) listener(event);
}

export function hasLiveRun(agentId: string): boolean {
  return liveRuns.has(agentId);
}

// 新会话标题生成和 run 是并行的两条独立流程(见 titleService.ts),标题就绪后
// 经这里广播给所有正在观看这个 agent 的订阅者,不管是不是发起方。
export function broadcastTitle(agentId: string, title: string): void {
  const live = liveRuns.get(agentId);
  if (live) broadcast(live, { type: "title", agentId, title });
}

// 订阅成功时立即补发一条 attach 事件(见 RunAttachEvent);若 run 已到终态但仍在
// 宽限期内,紧接着再补发那条 done,让接入端立刻拿到终止信号转去拉 /api/conversation。
// 返回 null 代表压根没有 live run(从未开始,或宽限期已过)。
export function subscribe(agentId: string, listener: Listener): (() => void) | null {
  const live = liveRuns.get(agentId);
  // 决策·log-density: SSE 正常接入(含无 live run 的终止信号)不打 info,避免刷新刷屏。
  if (!live) {
    return null;
  }

  listener({
    type: "attach",
    agentId,
    userText: live.userText,
    ...(live.imageUrl ? { imageUrl: live.imageUrl } : {}),
  });
  // 决策·replay-backlog: 重放接入前已经发生的事件,补全断连前的 thinking/工具调用,
  // 而不只是从当下开始接后续尾巴——同步 for 循环 + 单线程,不会漏掉/重复和
  // 后面 live.subscribers 广播交错的事件。
  for (const event of live.events) listener(event);
  if (live.doneEvent) {
    listener(live.doneEvent);
    return () => {};
  }

  live.subscribers.add(listener);
  return () => {
    live.subscribers.delete(listener);
  };
}
