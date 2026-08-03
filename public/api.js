// 所有 fetch(...) 调用集中在这一个叶子模块里,不 import 任何业务模块。

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function fetchFolders() {
  const res = await fetch("/api/folders");
  return res.json();
}

export async function createFolder(cwd, name) {
  return postJson("/api/folders", { cwd, name });
}

export async function fetchAgentsPage(cwd, cursor) {
  const url = `/api/agents?cwd=${encodeURIComponent(cwd)}&cursor=${encodeURIComponent(cursor)}`;
  const res = await fetch(url);
  return res.json();
}

export async function renameAgentApi(cwd, agentId, name) {
  return postJson("/api/agent/rename", { cwd, agentId, name });
}

export async function deleteAgentApi(cwd, agentId) {
  return postJson("/api/agent/delete", { cwd, agentId });
}

export async function undoLastTurnApi(cwd, agentId) {
  return postJson("/api/agent/undo", { cwd, agentId });
}

export async function cancelRunApi(agentId) {
  return postJson("/api/agent/cancel", { agentId });
}

export async function fetchModels() {
  const res = await fetch("/api/models");
  return res.json();
}

export async function fetchGitStatus(cwd) {
  const url = `/api/git-status?cwd=${encodeURIComponent(cwd)}`;
  const res = await fetch(url);
  return res.json();
}

export async function fetchGitDiff(cwd) {
  const url = `/api/git-diff?cwd=${encodeURIComponent(cwd)}`;
  const res = await fetch(url);
  return res.json();
}

export async function fetchGitCommitMessage(cwd) {
  return postJson("/api/git-commit-message", { cwd });
}

export async function postGitCommitPush(cwd, message) {
  return postJson("/api/git-commit-push", { cwd, message });
}

export async function postGitPull(cwd) {
  return postJson("/api/git-pull", { cwd });
}

export async function fetchFsList(cwd, dirPath) {
  let url = `/api/fs/list?cwd=${encodeURIComponent(cwd)}`;
  if (dirPath) url += `&path=${encodeURIComponent(dirPath)}`;
  const res = await fetch(url);
  return res.json();
}

export async function fetchFsRead(cwd, filePath) {
  const url = `/api/fs/read?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`;
  const res = await fetch(url);
  return res.json();
}

export async function fetchFsSearch(cwd, q) {
  const url = `/api/fs/search?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  return res.json();
}

export async function fetchConversation(agentId, cwd) {
  const url = `/api/conversation?agentId=${encodeURIComponent(agentId)}&cwd=${encodeURIComponent(cwd)}`;
  const res = await fetch(url);
  return res.json();
}

export async function postChat({ cwd, agentId, text, model, image }) {
  const body = { cwd, agentId, text, model };
  // 决策·json-base64: 有图时带 { mimeType, data },服务端校验 mime/大小/vision。
  if (image) body.image = image;
  return postJson("/api/chat", body);
}

export function agentStreamUrl(agentId) {
  return `/api/agent/stream?agentId=${encodeURIComponent(agentId)}`;
}

export function ttsAudioUrl(runId) {
  return `/api/tts/${encodeURIComponent(runId)}`;
}

// 决策·side-store-by-runId: 历史/直播缩略图只走此 URL。
export function userImageUrl(runId) {
  return `/api/user-images/${encodeURIComponent(runId)}`;
}
