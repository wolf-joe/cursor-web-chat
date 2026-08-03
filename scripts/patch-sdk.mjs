#!/usr/bin/env node
/**
 * 决策·regex-inject-patch / 决策·patch-scope-1-2:
 * 对 @cursor/sdk@1.0.26 的 dist/esm 与 dist/cjs 定点注入 patch 1 + patch 2。
 * 任一条失配必须非零退出(静默跳过会让工具调用永久卡 RUNNING / Shell cwd 错绑)。
 * 打过补丁后对应「未修补」正则天然不再命中,以此作幂等判据。
 * 不注入 patch 3(team repos)。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

function fail(msg) {
  console.error(`[patch-sdk] ${msg}`);
  console.error(
    "[patch-sdk] 详见 docs/cursor_sdk_patches.md。若已升级 SDK,需按该文档重写本脚本锚点。",
  );
  process.exit(1);
}

let sdkRoot;
try {
  // package.json 不在 exports 里,不能 require.resolve('@cursor/sdk/package.json')。
  const entry = require.resolve("@cursor/sdk");
  // entry 形如 .../node_modules/@cursor/sdk/dist/esm/index.js
  sdkRoot = path.resolve(path.dirname(entry), "../..");
  if (!fs.existsSync(path.join(sdkRoot, "package.json"))) {
    sdkRoot = path.join(root, "node_modules", "@cursor", "sdk");
  }
} catch {
  sdkRoot = path.join(root, "node_modules", "@cursor", "sdk");
}
if (!fs.existsSync(path.join(sdkRoot, "package.json"))) {
  fail("找不到 @cursor/sdk,请先 npm install");
}

const pkg = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8"));
if (pkg.version !== "1.0.26") {
  fail(`期望 @cursor/sdk@1.0.26,实际 ${pkg.version};拒绝在未知版本上静默注入`);
}

/** @type {{ file: string, patches: { name: string, pristine: string, patched: string }[] }[]} */
const TARGETS = [
  {
    file: path.join(sdkRoot, "dist/esm/357.js"),
    patches: [
      {
        name: "patch1-stale-completion (esm)",
        pristine:
          'if(t===r())return e.sendUpdate(n,o);"toolCallCompleted"===(null===(s=o.message)||void 0===s?void 0:s.case)&&Ce.warn(n,"nal.await_stall.stale_completion_dropped",{attemptGen:t,currentGen:r()})',
        patched:
          'if(t===r())return e.sendUpdate(n,o);if("toolCallCompleted"===(null===(s=o.message)||void 0===s?void 0:s.case))return Ce.warn(n,"nal.await_stall.stale_completion_dropped",{attemptGen:t,currentGen:r()}),e.sendUpdate(n,o)',
      },
      {
        name: "patch2-model-pwd (esm)",
        pristine: "processWorkingDirectory:process.cwd()",
        patched: "processWorkingDirectory:t[0]??process.cwd()",
      },
      {
        name: "patch2-shell-clone (esm)",
        pristine:
          'const a=this.terminalExecutor??(0,p.createDefaultTerminalExecutor)({env:{CURSOR_AGENT:"1"},userTerminalHint:this.userTerminalHint});let c;if(this.workspacePaths.length>1){const e=this.workspacePaths.map((e=>(0,o.dirname)(e)));c=e.every((t=>t===e[0]))?e[0]:void 0}else c=t;let u=new Bi(a,',
        patched:
          'const a0=this.terminalExecutor??(0,p.createDefaultTerminalExecutor)({env:{CURSOR_AGENT:"1"},userTerminalHint:this.userTerminalHint});let c;if(this.workspacePaths.length>1){const e=this.workspacePaths.map((e=>(0,o.dirname)(e)));c=e.every((t=>t===e[0]))?e[0]:void 0}else c=t;const a="string"==typeof c&&c?a0.clone(c):a0;let u=new Bi(a,',
      },
    ],
  },
  {
    file: path.join(sdkRoot, "dist/cjs/223.js"),
    patches: [
      {
        name: "patch1-stale-completion (cjs)",
        pristine:
          'if(t===r())return e.sendUpdate(n,o);"toolCallCompleted"===(null===(i=o.message)||void 0===i?void 0:i.case)&&hn.warn(n,"nal.await_stall.stale_completion_dropped",{attemptGen:t,currentGen:r()})',
        patched:
          'if(t===r())return e.sendUpdate(n,o);if("toolCallCompleted"===(null===(i=o.message)||void 0===i?void 0:i.case))return hn.warn(n,"nal.await_stall.stale_completion_dropped",{attemptGen:t,currentGen:r()}),e.sendUpdate(n,o)',
      },
      {
        name: "patch2-model-pwd (cjs)",
        pristine: "processWorkingDirectory:process.cwd()",
        patched: "processWorkingDirectory:t[0]??process.cwd()",
      },
      {
        name: "patch2-shell-clone (cjs)",
        pristine:
          'const o=this.terminalExecutor??(0,io.createDefaultTerminalExecutor)({env:{CURSOR_AGENT:"1"},userTerminalHint:this.userTerminalHint});let l;if(this.workspacePaths.length>1){const e=this.workspacePaths.map((e=>(0,a.dirname)(e)));l=e.every((t=>t===e[0]))?e[0]:void 0}else l=t;let c=new Sv(o,',
        patched:
          'const o0=this.terminalExecutor??(0,io.createDefaultTerminalExecutor)({env:{CURSOR_AGENT:"1"},userTerminalHint:this.userTerminalHint});let l;if(this.workspacePaths.length>1){const e=this.workspacePaths.map((e=>(0,a.dirname)(e)));l=e.every((t=>t===e[0]))?e[0]:void 0}else l=t;const o="string"==typeof l&&l?o0.clone(l):o0;let c=new Sv(o,',
      },
    ],
  },
];

let applied = 0;
let skipped = 0;

for (const target of TARGETS) {
  if (!fs.existsSync(target.file)) {
    fail(`缺少文件: ${path.relative(root, target.file)}`);
  }
  let src = fs.readFileSync(target.file, "utf8");
  let dirty = false;

  for (const patch of target.patches) {
    const hasPristine = src.includes(patch.pristine);
    const hasPatched = src.includes(patch.patched);
    if (hasPatched && !hasPristine) {
      skipped += 1;
      console.log(`[patch-sdk] 已注入,跳过: ${patch.name}`);
      continue;
    }
    if (!hasPristine) {
      fail(`锚点失配: ${patch.name}\n  文件: ${path.relative(root, target.file)}`);
    }
    // pristine 可能出现多次时拒绝(processWorkingDirectory 已确认唯一;其余应唯一)
    const count = src.split(patch.pristine).length - 1;
    if (count !== 1) {
      fail(`锚点命中 ${count} 次(期望 1): ${patch.name}`);
    }
    src = src.replace(patch.pristine, patch.patched);
    dirty = true;
    applied += 1;
    console.log(`[patch-sdk] 已注入: ${patch.name}`);
  }

  if (dirty) {
    fs.writeFileSync(target.file, src, "utf8");
  }
}

console.log(`[patch-sdk] 完成: 新注入 ${applied}, 已存在跳过 ${skipped}`);
