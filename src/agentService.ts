import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  Agent,
  type SDKAgent,
  type SDKAgentInfo,
  type Run,
  type ListResult,
  type ModelSelection,
} from "@cursor/sdk";
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";
import { log, previewText } from "./logger.js";

// 实测坐实(见对话记录): 1 个 cached local agent 常驻内存的边际开销大概
// 150~300MB(小仓库,含 tsx watch 开销的区间)。数量上限 + 空闲 TTL 都可以用
// 环境变量覆盖,默认值按"给这个服务预留 ~2GB"估算。
const MAX_CACHED_AGENTS = Number(process.env.AGENT_CACHE_MAX ?? 8);
const IDLE_TTL_MS = Number(process.env.AGENT_CACHE_IDLE_TTL_MS ?? 30 * 60 * 1000);
// 决策·max-age-45m: SDK 按 cwd 复用 LocalExecutor,accessToken 缓存在闭包里且
// AUTH_TOKEN_EXPIRED 不触发重换票;与 AGENT_CACHE_* 正交——后者管内存,本常量管
// token 寿命窗口。实测约 58~63min 中毒,默认 45min 留余量;
// 可用 AGENT_EXECUTOR_MAX_AGE_MS 覆盖。
const EXECUTOR_MAX_AGE_MS = Number(
  process.env.AGENT_EXECUTOR_MAX_AGE_MS ?? 45 * 60 * 1000,
);

interface CacheEntry {
  agent: SDKAgent;
  busy: boolean;
  lastUsedAt: number;
  // 决策·cwd-lease-age: 同 cwd 共享一个 LocalExecutor,淘汰/限龄都按 cwd 聚合。
  cwd: string;
  // 当前这次 send() 产生的 Run 句柄,只在 busy===true 期间有意义——
  // 停止按钮(cancelRun)靠它调 run.cancel(),run 结束/clearBusy 时清空。
  currentRun?: Run;
}

// agentId -> live SDKAgent handle. send()/stream() need the handle already
// acquired; a cache miss falls back to Agent.resume() (see 决策·agent-cache)。
// 淘汰策略见 admitToCache/evictIdle/evictLru: 数量超过 MAX_CACHED_AGENTS 时按
// 最久未用淘汰,另外无论数量,空闲超过 IDLE_TTL_MS 的条目也会被清掉——两者都
// 只淘汰 busy===false 的条目,正在跑的 run 不会被打断。
const agentCache = new Map<string, CacheEntry>();

// 决策·cwd-lease-age: 该 cwd 仍有任一缓存句柄时保留首次租约起点;清光后删除,
// 下次 admit 重新记时。限龄判断必须 cwd 级,不能按单个 agent。
const cwdFirstLeaseAt = new Map<string, number>();

// 压测坐实: 两个并发请求打同一个未缓存的 agentId 会同时 miss 缓存、同时调用
// Agent.resume(),两个独立句柄同时 send() 会在底层 SQLite store 上撞
// UNIQUE constraint (runs.agent_id, runs.turn_number)。用这个 map 把并发 resume
// 收敛成同一个 in-flight promise,后来者等同一个结果,而不是各自再 resume 一次。
const pendingResumes = new Map<string, Promise<CacheEntry>>();

export class AgentBusyLocallyError extends Error {
  constructor(agentId: string) {
    super(`agent ${agentId} 有一个 run 尚未结束,请等待完成`);
    this.name = "AgentBusyLocallyError";
  }
}

export class AgentDeleteBusyError extends Error {
  constructor(agentId: string) {
    super(`agent ${agentId} 有一个 run 正在进行,请先等待完成再删除`);
    this.name = "AgentDeleteBusyError";
  }
}

export class AgentCancelNotRunningError extends Error {
  constructor(agentId: string) {
    super(`agent ${agentId} 当前没有正在进行的 run,无法停止`);
    this.name = "AgentCancelNotRunningError";
  }
}

export class AgentUndoBusyError extends Error {
  constructor(agentId: string) {
    super(`agent ${agentId} 有一个 run 正在进行,请先等待完成再撤销`);
    this.name = "AgentUndoBusyError";
  }
}

export class AgentUndoNoTurnsError extends Error {
  constructor(agentId: string) {
    super(`agent ${agentId} 没有可撤销的历史轮次`);
    this.name = "AgentUndoNoTurnsError";
  }
}

function clearCwdLeaseIfEmpty(cwd: string): void {
  for (const entry of agentCache.values()) {
    if (entry.cwd === cwd) return;
  }
  cwdFirstLeaseAt.delete(cwd);
}

function noteCwdLease(cwd: string): void {
  if (!cwdFirstLeaseAt.has(cwd)) {
    cwdFirstLeaseAt.set(cwd, Date.now());
  }
}

// 决策·async-dispose: close() 不 await releaseExecutorLease,refs 可能下不完;
// 用 asyncDispose 才能真正把 LocalExecutor 的租约放干净。
async function disposeAgent(agent: SDKAgent): Promise<void> {
  await agent[Symbol.asyncDispose]();
}

async function evictEntry(agentId: string, entry: CacheEntry): Promise<void> {
  log.info("agent 缓存淘汰", { agentId, cwd: entry.cwd });
  agentCache.delete(agentId);
  await disposeAgent(entry.agent);
  clearCwdLeaseIfEmpty(entry.cwd);
}

async function evictIdle(): Promise<void> {
  const cutoff = Date.now() - IDLE_TTL_MS;
  for (const [agentId, entry] of agentCache) {
    if (!entry.busy && entry.lastUsedAt < cutoff) await evictEntry(agentId, entry);
  }
}

async function evictLru(): Promise<void> {
  if (agentCache.size <= MAX_CACHED_AGENTS) return;
  const idleOldestFirst = [...agentCache.entries()]
    .filter(([, entry]) => !entry.busy)
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  // busy 条目算不进"可淘汰"名额,size 可能短暂超出 MAX_CACHED_AGENTS——
  // 这是软上限,不为了硬保证而打断正在跑的 run。
  while (agentCache.size > MAX_CACHED_AGENTS && idleOldestFirst.length) {
    const [agentId, entry] = idleOldestFirst.shift()!;
    await evictEntry(agentId, entry);
  }
}

async function admitToCache(agentId: string, agent: SDKAgent, cwd: string): Promise<CacheEntry> {
  await evictIdle();
  const entry: CacheEntry = { agent, busy: false, lastUsedAt: Date.now(), cwd };
  agentCache.set(agentId, entry);
  noteCwdLease(cwd);
  await evictLru();
  return entry;
}

// 决策·no-auth-fallback / 决策·lease-age-log: 不在 auth 失败后再 flush;
// 每次 send 检查 cwd 租约年龄,仅超龄时 warn 并丢掉空闲句柄,逼 SDK 换新 executor。
// 健康路径不打 info(见 docs/proposals/20260723.log-density.md)。
async function maybeFlushStaleExecutorLease(cwd: string): Promise<void> {
  const firstLeaseAt = cwdFirstLeaseAt.get(cwd);
  const ageMs = firstLeaseAt !== undefined ? Date.now() - firstLeaseAt : 0;
  const cachedForCwd = [...agentCache.entries()].filter(([, entry]) => entry.cwd === cwd);

  if (firstLeaseAt === undefined || ageMs <= EXECUTOR_MAX_AGE_MS) return;

  log.warn("executor 租约超龄,开始 flush 空闲句柄", {
    cwd,
    ageMs,
    maxAgeMs: EXECUTOR_MAX_AGE_MS,
    cachedCount: cachedForCwd.length,
  });
  for (const [agentId, entry] of cachedForCwd) {
    if (entry.busy) {
      log.warn("executor 超龄 flush 跳过 busy agent", { cwd, agentId });
      continue;
    }
    await evictEntry(agentId, entry);
  }
}

// 兜底:即便没有新请求触发 admitToCache,空闲超时的 agent 也会被定期清掉。
setInterval(() => {
  void evictIdle();
}, Math.min(IDLE_TTL_MS, 5 * 60 * 1000)).unref();

export async function createAgent(cwd: string, model: ModelSelection): Promise<SDKAgent> {
  // 决策·setting-sources: SDK 默认 settingSources 为 undefined,解析后 project/user/...
  // 全为 false,导致 localExtensibility 整个模块不被创建,LocalCursorRulesService.load
  // 永远不执行--AGENTS.md / .cursorrules 等项目级规则文件完全不会被加载注入到
  // agent 的 system prompt(实测坐实:不传时 AI 明确回答"规则里没有 AGENTS.md 内容";
  // 传 ["project"] 后日志出现 "LocalCursorRulesService load completed ruleCount: 1",
  // AI 能准确复述 AGENTS.md 第一段)。必须在 create/resume 时显式开启。
  // "user" 同步打开 ~/.cursor/skills、~/.cursor/mcp.json 等用户层配置
  // (skills 与 AGENTS.md 同一道闸,无单独的 skills API 开关)。
  const agent = await Agent.create({
    apiKey: process.env.CURSOR_API_KEY,
    model,
    local: { cwd, settingSources: ["project", "user"] },
  });
  // 决策·log-density: 创建成功并入 sendMessage 的「聊天 run 已建立」(cache:create)。
  await admitToCache(agent.agentId, agent, cwd);
  return agent;
}

type ResolveCacheKind = "hit" | "resume";

async function resolveAgent(
  agentId: string,
  cwd: string,
  model: ModelSelection,
): Promise<{ entry: CacheEntry; cache: ResolveCacheKind }> {
  const cached = agentCache.get(agentId);
  if (cached) {
    cached.lastUsedAt = Date.now();
    return { entry: cached, cache: "hit" };
  }

  let pending = pendingResumes.get(agentId);
  if (!pending) {
    pending = (async () => {
      // 实测坐实: local agent resume 后 agent.model 是 undefined,send() 会直接报错
      // "Local SDK agents require an explicit model"——必须在 resume 时也显式传 model。
      // 这里传的 model 只是满足这个前置条件,真正生效的选择以 sendMessage 里
      // send(text, { model }) 的显式覆盖为准(§文档: send 的 model 覆盖当次运行)。
      const agent = await Agent.resume(agentId, {
        apiKey: process.env.CURSOR_API_KEY,
        model,
        local: { cwd, settingSources: ["project", "user"] },
      });
      return admitToCache(agentId, agent, cwd);
    })();
    pendingResumes.set(agentId, pending);
  }

  try {
    return { entry: await pending, cache: "resume" };
  } catch (err) {
    log.error("agent resume 失败", err, { agentId, cwd, model });
    throw err;
  } finally {
    pendingResumes.delete(agentId);
  }
}

export async function sendMessage(
  agentId: string | undefined,
  cwd: string,
  text: string,
  model: ModelSelection,
  // 决策·sdk-send-images: 有图时走 SDKUserMessage { text, images },无图仍传 string。
  images?: Array<{ data: string; mimeType: string }>,
): Promise<{ agent: SDKAgent; run: Run }> {
  // 决策·lease-age-log / 决策·no-auth-fallback: 先检查租约;超龄则 flush 空闲句柄
  // 后再 create/resume——不根据 auth 文案自动重试。健康路径不打 age info。
  await maybeFlushStaleExecutorLease(cwd);

  const message =
    images && images.length > 0
      ? { text, images: images.map((img) => ({ data: img.data, mimeType: img.mimeType })) }
      : text;

  const milestoneBase = {
    cwd,
    model,
    textLen: text.length,
    textPreview: previewText(text),
    imageCount: images?.length ?? 0,
  };

  if (!agentId) {
    const agent = await createAgent(cwd, model);
    // admitToCache 刚把这个 agent 放进缓存,取回来标 busy 好让停止按钮(cancelRun)
    // 找得到 currentRun——新会话的第一次 send() 之前遗漏了这一步,run.busy 一直是
    // false,和续聊分支(下面)对不上。
    const entry = agentCache.get(agent.agentId)!;
    entry.busy = true;
    try {
      // 决策·force-agent-mode: 每轮显式钉死 agent；omit 会 sticky 当前 mode，
      // 而 local SDK 会静默批准 SwitchMode，导致后续轮次卡在 plan。
      const run = await agent.send(message, { mode: "agent" });
      entry.currentRun = run;
      // 决策·send-milestone-agentService / 决策·log-density: 成功只在此打一条。
      log.info("聊天 run 已建立", {
        ...milestoneBase,
        agentId: agent.agentId,
        runId: run.id,
        mode: "新建",
        cache: "create",
      });
      return { agent, run };
    } catch (err) {
      entry.busy = false;
      log.error("agent.send 失败(新建会话)", err, { agentId: agent.agentId, cwd, model });
      throw err;
    }
  }

  const { entry, cache } = await resolveAgent(agentId, cwd, model);
  if (entry.busy) {
    log.warn("agent.send 被拒绝:本地仍有未结束的 run", { agentId, cwd });
    throw new AgentBusyLocallyError(agentId);
  }
  entry.busy = true;
  try {
    // 显式覆盖:即便命中缓存(entry.agent 可能是更早的模型选择恢复的),
    // 也要以这次请求带来的 model 为准,支持同一会话中途切模型。
    // 决策·force-agent-mode: 续聊同样钉 agent，并保留 model 覆盖。
    const run = await entry.agent.send(message, { model, mode: "agent" });
    entry.currentRun = run;
    // 决策·send-milestone-agentService / 决策·log-density: 成功只在此打一条。
    log.info("聊天 run 已建立", {
      ...milestoneBase,
      agentId,
      runId: run.id,
      mode: "续聊",
      cache,
    });
    // busy 保持 true,由调用方(server.ts)在流结束后调用 clearBusy——
    // send() resolve 只代表 run 已建立,还没跑完。
    return { agent: entry.agent, run };
  } catch (err) {
    entry.busy = false;
    log.error("agent.send 失败(续聊)", err, { agentId, cwd, model });
    throw err;
  }
}

export function clearBusy(agentId: string): void {
  const entry = agentCache.get(agentId);
  if (entry) {
    entry.busy = false;
    entry.currentRun = undefined;
    // run 结束才是这个 agent 真正"变空闲"的时刻,而不是它被取出缓存的时刻——
    // 用这个时间点重新计空闲 TTL,避免长 run 跑到一半就被当成空闲淘汰。
    entry.lastUsedAt = Date.now();
  }
}

// 决策·stop-button: local runtime 下浏览器断连不会取消 run(见 CLAUDE.md),
// 之前唯一能中断一次误发消息的手段是直接 kill 掉 node 进程——这会在 SQLite 里
// 留下永远卡在 running 状态的孤儿 agent/run(见 reconcileOrphanedAgents 的注释)。
// 这里补一个真正的停止入口,直接调 run.cancel():状态会变成 cancelled 并落盘,
// run.stream() 会中止,server.ts 里的 for-await 循环随之正常结束、写出 done 事件,
// 不会留下任何孤儿状态。
export async function cancelRun(agentId: string): Promise<void> {
  const entry = agentCache.get(agentId);
  if (!entry?.busy || !entry.currentRun) {
    log.warn("取消 run 失败:当前没有进行中的 run", { agentId });
    throw new AgentCancelNotRunningError(agentId);
  }
  log.info("取消 run", { agentId, runId: entry.currentRun.id });
  await entry.currentRun.cancel();
}

// true = agent 句柄已在内存缓存中,续聊直接 send() 即可;
// false = 需要先走 Agent.resume() 冷启动。
export function isAgentCached(agentId: string): boolean {
  return agentCache.has(agentId);
}

export async function listFolderAgents(
  cwd: string,
  options?: { limit?: number; cursor?: string },
): Promise<ListResult<SDKAgentInfo>> {
  return Agent.list({ runtime: "local", cwd, limit: options?.limit, cursor: options?.cursor });
}

// 决策·agent-count-sqlite: Agent.list 只给 {items,nextCursor}、没有 total;侧边栏又
// 只分页拉最近 N 条,badge 若用 agents.length 会低估。每个 cwd 一份 index.db、
// agents 表只是元数据行,SELECT COUNT(*) 比翻完所有分页轻得多。公开 API 没有
// count 入口,和 rename/delete/orphan 一样直接碰 SqliteLocalAgentStore 那份库。
export async function countFolderAgents(cwd: string): Promise<number> {
  const store = await getLocalStore(cwd);
  const dbPath = path.join(store.stateRoot, "index.db");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number } | undefined;
    return row?.n ?? 0;
  } finally {
    db.close();
  }
}

export async function listAgentRuns(agentId: string, cwd: string): Promise<Run[]> {
  const { items } = await Agent.listRuns(agentId, { runtime: "local", cwd });
  return items;
}

// 决策·rename-delete: Agent.archive/unarchive/delete 是 cloud-only(SDK 文档明确注明),
// 本地 agent 没有对应的公开静态方法。但本地默认存储 SqliteLocalAgentStore 本身对外公开
// 且文档写明"没有传自定义 local.store 时 SDK 打开的就是它"——直接对它做增删改,读写的
// 是与 Agent.create/list 完全相同的那份 sqlite 文件,而不是另建一套影子存储。
const localStoreCache = new Map<string, Promise<SqliteLocalAgentStore>>();

// history / checkpoint 用户原文等与 rename/undo 共用同一份 store 句柄缓存。
export function getLocalStore(cwd: string): Promise<SqliteLocalAgentStore> {
  let pending = localStoreCache.get(cwd);
  if (!pending) {
    pending = SqliteLocalAgentStore.open({ workspaceRef: cwd });
    localStoreCache.set(cwd, pending);
  }
  return pending;
}

// 决策·orphan-reconcile: 排查过一次真实故障坐实(kill 掉本进程打断一次未结束的
// 消息)——SQLite 里那个 agent/run 永远卡在 running,从此之后:(a) /api/conversation
// 里 run.conversation() 内部等的是这个 run 的终态事件,永远等不到,请求挂死不返回;
// (b) 这个 agent 也没法再 send() 续聊,SDK 会直接报 "already has active run"。没有
// 任何机制会在进程死后把状态改回来,因为写"终态"这个动作本身是由那个已经不存在的
// 进程负责的。
//
// 修复时机放在进程启动、而不是遇到卡住的历史再修:这是单进程 local runtime,一旦
// 新进程跑到这里,旧进程必然已经不在了(不存在"其实还在正常跑,不能动"的可能性),
// 所以可以放心把所有 folder 下还标着 running/queued 的 agent/run 一次性拨回终态,
// 不需要针对单个 agentId 现查现修。
export async function reconcileOrphanedAgents(cwd: string): Promise<number> {
  const store = await getLocalStore(cwd);
  const { items: agents } = await store.agents.list({ filter: { cwd } });
  let fixed = 0;

  for (const agent of agents) {
    if (agent.status !== "running") continue;

    log.warn("发现孤儿 agent,开始回收", { cwd, agentId: agent.agentId });

    const { items: runs } = await store.runs.list({ filter: { agentIds: [agent.agentId] } });
    for (const run of runs) {
      if (run.status !== "running" && run.status !== "queued") continue;
      log.warn("回收孤儿 run", { cwd, agentId: agent.agentId, runId: run.runId, status: run.status });
      await store.runs.update({
        run: {
          ...run,
          status: "error",
          error: "进程异常退出,run 未能正常结束(启动时自动回收)",
          endedAt: Date.now(),
        },
      });
      fixed += 1;
    }

    await store.agents.update({ agent: { ...agent, status: "idle", activeRunId: null } });
  }

  return fixed;
}

// 决策·undo-last-turn: 实测验证过(一次性测试 agent + 手动拨 checkpoint + 重新
// resume 探测)——Agent.resume() 续聊确实认 agent 表的 latestCheckpoint 字段,把它
// 拨回某一轮自己的 startCheckpointRef,续聊时 AI 就真的不知道这轮发生过,不是
// 界面隐藏那种表面功夫。只能撤销链条末尾(turnNumber 最大)的那一轮——中间某轮
// 的 checkpoint 是它后面所有轮次续聊的父状态,抽掉会破坏链条,所以这里不接受
// 指定 runId,永远只操作"当前最后一轮"。
export async function undoLastTurn(
  cwd: string,
  agentId: string,
): Promise<{ runId: string }> {
  const entry = agentCache.get(agentId);
  if (entry?.busy) throw new AgentUndoBusyError(agentId);

  const store = await getLocalStore(cwd);
  const { items: runs } = await store.runs.list({ filter: { agentIds: [agentId] } });
  if (runs.length === 0) throw new AgentUndoNoTurnsError(agentId);

  const lastRun = [...runs].sort((a, b) => b.turnNumber - a.turnNumber)[0];

  const agentDoc = await store.agents.get({ agentId });
  if (!agentDoc) throw new Error(`agent ${agentId} 不存在`);

  await store.agents.update({
    agent: { ...agentDoc, latestCheckpoint: lastRun.startCheckpointRef ?? null },
  });
  await store.runEvents.delete({ filter: { runIds: [lastRun.runId] } });
  await store.runs.delete({ filter: { runIds: [lastRun.runId] } });

  // 内存里缓存的 agent 句柄自己攒着一份内部状态,不会因为我们改了 SQLite 就自动
  // 重新读盘——必须连带清掉缓存,下次 send() 强制走 Agent.resume() 冷启动,才能
  // 真正吃到刚拨回去的 checkpoint(和 deleteAgent 已有的做法一致)。
  if (entry) await evictEntry(agentId, entry);

  // 供调用方同步清理 TTS 缓存(决策·undo-deletes-tts)。
  return { runId: lastRun.runId };
}

export async function renameAgent(cwd: string, agentId: string, name: string): Promise<void> {
  const store = await getLocalStore(cwd);
  const doc = await store.agents.get({ agentId });
  if (!doc) throw new Error(`agent ${agentId} 不存在`);
  await store.agents.update({ agent: { ...doc, name } });
}

export async function deleteAgent(
  cwd: string,
  agentId: string,
): Promise<{ runIds: string[] }> {
  const entry = agentCache.get(agentId);
  if (entry?.busy) throw new AgentDeleteBusyError(agentId);
  if (entry) await evictEntry(agentId, entry);

  const store = await getLocalStore(cwd);

  // run_events 只能按 runId 过滤删除,得先分页取出这个 agent 名下所有 runId。
  const runIds: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.runs.list({ filter: { agentIds: [agentId], cursor } });
    runIds.push(...page.items.map((r) => r.runId));
    cursor = page.nextCursor;
  } while (cursor);

  if (runIds.length) await store.runEvents.delete({ filter: { runIds } });
  await store.runs.delete({ filter: { agentIds: [agentId] } });
  await store.checkpoints.delete({ filter: { agentIds: [agentId] } });
  await store.agents.delete({ filter: { agentIds: [agentId] } });

  // 供调用方同步清理该 agent 下全部 TTS 缓存(决策·delete-agent-tts)。
  return { runIds };
}
