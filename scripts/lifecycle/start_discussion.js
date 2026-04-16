#!/usr/bin/env node
/**
 * Multi-agent team discussion orchestrator.
 *
 * 主题：为 GameStudio 项目打造基础测试方案
 *
 * 流程：
 *   Phase 1: Planner  → 写入 memory/discussion/01-planner.md
 *   Phase 2: Executor → 写入 memory/discussion/02-executor.md
 *   Phase 3: Critic   → 写入 memory/discussion/03-critic.md
 *   Phase 4: Reporter → 写入 memory/discussion/04-reporter.md + 发邮件
 *
 *   全程每 10 分钟触发 Reporter 发一封进度邮件。
 *   结束后编译完整记录到 memory/YYYY-MM-DD-discussion.md
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── 路径配置 ──────────────────────────────────────────────────────────────
const projectDir      = path.resolve(__dirname, '..', '..');
const monitorNM       = path.join(projectDir, 'monitor', 'openclaw', 'node_modules');
const WebSocket       = require(path.join(monitorNM, 'ws'));
const sodium          = require(path.join(monitorNM, 'sodium-native'));

const discussionDir   = path.join(projectDir, 'memory', 'discussion');
const dateStr         = new Date().toISOString().slice(0, 10);
const masterLogFile   = path.join(projectDir, 'memory', `${dateStr}-discussion.md`);
const identityFile    = path.join(projectDir, 'monitor', 'openclaw', '.device_identity.json');

// ─── 超时参数 ──────────────────────────────────────────────────────────────
const POLL_MS           = 30 * 1000;        // 轮询间隔 30 秒
const PHASE_TIMEOUT_MS  = 8 * 60 * 1000;    // 每阶段最长 8 分钟
const REPORTER_EVERY_MS = 10 * 60 * 1000;   // Reporter 进度邮件间隔 10 分钟
const MIN_FILE_BYTES    = 150;              // 输出文件最小字节数（判断"写完了"）

// ─── 讨论主题 ──────────────────────────────────────────────────────────────
const TOPIC = `为 GameStudio H5 交互故事生产项目打造基础测试方案。

项目背景：
- Server: Hono + Node.js，端口 1999，提供故事/蓝图/资产 API
- Editor: Vite + React，端口 8868，可视化编辑故事脚本与蓝图
- 核心生产链路：故事创建 → 脚本转蓝图 → 连续性约束 → 场景图生成 → 合成导出
- 当前在推进：正式场景出图验证

讨论目标（形成具体建议）：
1. 端到端冒烟测试方案（覆盖核心生产链路的最小可运行验证）
2. API 集成测试方案（Server 的关键接口测试）
3. 前端基础测试方案（Editor 组件关键行为测试）
4. 各方案的优先级、推荐工具与执行方式`;

// ─── 工具函数 ──────────────────────────────────────────────────────────────
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(masterLogFile, line + '\n');
}

function writeSection(title, content) {
  const section = `\n${'─'.repeat(60)}\n## ${title}\n${'─'.repeat(60)}\n${content}\n`;
  fs.appendFileSync(masterLogFile, section);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function readFileSafe(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

/**
 * 轮询等待文件出现且有实质内容
 * 返回文件内容，超时返回 null
 */
async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let logged = false;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const size = fs.statSync(filePath).size;
      if (size >= MIN_FILE_BYTES) {
        return fs.readFileSync(filePath, 'utf-8');
      }
      if (!logged) {
        log(`  ⏳ 文件已创建但内容不足（${size} bytes），继续等待...`);
        logged = true;
      }
    }
    await sleep(POLL_MS);
  }
  return null;
}

// ─── Ed25519 身份 ──────────────────────────────────────────────────────────
function loadOrCreateIdentity() {
  if (fs.existsSync(identityFile)) {
    const d = JSON.parse(fs.readFileSync(identityFile, 'utf-8'));
    return {
      deviceId:   d.deviceId,
      publicKey:  Buffer.from(d.publicKey,  'base64'),
      privateKey: Buffer.from(d.privateKey, 'base64')
    };
  }
  const pub  = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
  const priv = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
  sodium.crypto_sign_keypair(pub, priv);
  const deviceId = crypto.createHash('sha256').update(pub).digest('hex');
  fs.writeFileSync(identityFile, JSON.stringify({
    deviceId,
    publicKey:  pub.toString('base64'),
    privateKey: priv.toString('base64')
  }, null, 2));
  return { deviceId, publicKey: pub, privateKey: priv };
}

function urlBase64(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── OpenClaw 配置 ─────────────────────────────────────────────────────────
function loadOpenClawConfig() {
  const candidates = [
    path.join(process.env.HOME || '', '.openclaw', 'openclaw.json'),
    '/Volumes/ovokit2t/AIOVO/home/.openclaw/openclaw.json'
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch {}
    }
  }
  return {};
}

// ─── RpcClient ────────────────────────────────────────────────────────────
class RpcClient {
  constructor({ wsUrl, gatewayToken, identity, origin }) {
    this.wsUrl        = wsUrl;
    this.gatewayToken = gatewayToken;
    this.identity     = identity;
    this.origin       = origin;
    this.ws           = null;
    this.reqId        = 0;
    this.pending      = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl, {
        handshakeTimeout: 15000,
        headers: { Origin: this.origin }
      });
      this.ws.on('error', reject);
      this.ws.on('message', data => this._onMessage(data, resolve, reject));
      this.ws.on('close', () => {
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`socket closed waiting for ${id}`));
        }
        this.pending.clear();
      });
    });
  }

  _onMessage(data, resolveConnect, rejectConnect) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      const nonce    = msg.payload?.nonce;
      const clientId = 'openclaw-control-ui';
      const role     = 'operator';
      const scopes   = ['operator.admin', 'operator.read', 'operator.write'];
      const signedAt = Date.now();
      const sigStr   = `v2|${this.identity.deviceId}|${clientId}|ui|${role}|${scopes.join(',')}|${signedAt}|${this.gatewayToken}|${nonce}`;
      const sig      = Buffer.alloc(sodium.crypto_sign_BYTES);
      sodium.crypto_sign_detached(sig, Buffer.from(sigStr), this.identity.privateKey);
      this.ws.send(JSON.stringify({
        type: 'req', id: 'connect-auth', method: 'connect',
        params: {
          minProtocol: 3, maxProtocol: 3,
          client: { id: clientId, version: '1.0.0', platform: process.platform, mode: 'ui' },
          role, scopes,
          device: {
            id: this.identity.deviceId,
            publicKey:  urlBase64(this.identity.publicKey),
            signature:  urlBase64(sig),
            signedAt, nonce
          },
          caps: ['tool-events'],
          auth: { token: this.gatewayToken, password: '' }
        }
      }));
      return;
    }

    if (msg.type === 'res' && msg.id === 'connect-auth') {
      if (msg.ok) resolveConnect(msg.payload);
      else rejectConnect(new Error(`connect failed: ${msg.error?.message || msg.error}`));
      return;
    }

    if (msg.type === 'res') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.payload);
      else p.reject(new Error(msg.error?.message || msg.error || 'rpc failed'));
    }
  }

  send(method, params = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('ws not connected'));
      }
      const id    = `req-${++this.reqId}-${Date.now()}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  close() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close();
  }
}

// ─── 发送消息给代理（创建新 session） ─────────────────────────────────────
async function sendToAgent(client, agentId, key, message) {
  log(`  → 向 ${agentId} (${key}) 发送任务...`);
  const result = await client.send('sessions.create', {
    agentId,
    key,
    label: key,
    message
  }, 30000);
  log(`  ✅ ${agentId} session 已创建: ${result?.key || key}`);
  return result;
}

// ─── 主流程 ───────────────────────────────────────────────────────────────
async function main() {
  ensureDir(discussionDir);

  // 初始化主日志文件
  fs.writeFileSync(masterLogFile,
    `# 团队讨论记录\n日期：${dateStr}\n主题：为 GameStudio 项目打造基础测试方案\n\n`
  );
  log('🚀 多代理团队讨论开始');

  const cfg          = loadOpenClawConfig();
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || cfg.gateway?.auth?.token || '';
  const wsUrl        = process.env.OPENCLAW_GATEWAY_URL   || 'ws://127.0.0.1:18789';
  const wsOrigin     = process.env.OPENCLAW_GATEWAY_ORIGIN || 'http://127.0.0.1:18789';
  const identity     = loadOrCreateIdentity();
  const client       = new RpcClient({ wsUrl, gatewayToken, identity, origin: wsOrigin });

  await client.connect();
  log('✅ 已连接到 OpenClaw gateway');

  // 10 分钟 Reporter 定时汇报计时器
  let phaseLabel = '讨论启动中';
  let reporterTimerCount = 0;
  const reporterTimer = setInterval(async () => {
    reporterTimerCount++;
    log(`⏰ 10分钟定时触发 Reporter 进度汇报 #${reporterTimerCount}（当前阶段：${phaseLabel}）`);
    try {
      await sendToAgent(client, 'reporter', `progress-${reporterTimerCount}`,
        `请进行第 ${reporterTimerCount} 次进度汇报（每10分钟一次）。

当前讨论阶段：${phaseLabel}

请：
1. 读取 memory/discussion/ 目录下已完成的文件，汇总当前进展
2. 运行 bash scripts/lifecycle/status_project.sh 检查服务状态
3. 发送进度邮件（bash scripts/lifecycle/reporter_email.sh）
4. 将本次汇报内容写入 memory/discussion/reporter-progress-${reporterTimerCount}.md

格式：
- 🕐 汇报时间
- 📊 当前讨论阶段
- 📋 已完成的内容摘要
- ⏳ 当前进行中的阶段
- 🎯 预计完成时间`
      );
    } catch (err) {
      log(`  ⚠️ Reporter 定时汇报失败: ${err.message}`);
    }
  }, REPORTER_EVERY_MS);

  try {
    const plannerOut  = path.join(discussionDir, '01-planner.md');
    const executorOut = path.join(discussionDir, '02-executor.md');
    const criticOut   = path.join(discussionDir, '03-critic.md');
    const reporterOut = path.join(discussionDir, '04-reporter.md');

    // ── Phase 1: Planner ────────────────────────────────────────────────
    phaseLabel = 'Phase 1 - Planner 制定框架';
    log(`\n${'═'.repeat(50)}`);
    log(`📋 Phase 1: 触发 Planner 制定测试方案框架`);
    log(`${'═'.repeat(50)}`);

    await sendToAgent(client, 'planner', 'discussion-phase1', `你是本次团队讨论的主持人。请仔细分析以下项目，制定基础测试方案框架。

讨论主题：
${TOPIC}

你的任务：
1. 读取项目关键文件了解背景：
   - README.md
   - memory/STATUS.md
   - memory/TASK_QUEUE.md
   - apps/server/src/ 目录结构

2. 制定基础测试方案框架，需要包含：
   a. 端到端冒烟测试（覆盖核心生产链路最小验证）
   b. API 集成测试（Server 关键接口测试清单）
   c. 前端基础测试（Editor 关键组件行为测试）
   d. 各方案的优先级排序（P0/P1/P2）
   e. 推荐工具与执行命令

3. 将完整方案框架写入文件：memory/discussion/01-planner.md
   - 格式要清晰，有章节标题
   - 包含具体的测试用例描述（至少 5 个 P0 用例）
   - 文件写完后最后一行写：<!-- DONE -->

完成后等待 Executor 接棒。`
    );

    log(`⏳ 等待 Planner 完成写入（最长 8 分钟）...`);
    const plannerContent = await waitForFile(plannerOut, PHASE_TIMEOUT_MS);
    if (!plannerContent) {
      log(`⚠️ Planner 超时未完成写入，跳过等待继续下一阶段`);
      fs.writeFileSync(plannerOut, `# Planner 输出（超时）\n\n未能在 8 分钟内获得输出。\n<!-- DONE -->\n`);
    } else {
      log(`✅ Planner 完成！输出 ${plannerContent.length} 字`);
      writeSection('Phase 1 - Planner 框架', plannerContent);
    }

    // ── Phase 2: Executor ───────────────────────────────────────────────
    phaseLabel = 'Phase 2 - Executor 补充技术细节';
    log(`\n${'═'.repeat(50)}`);
    log(`🔧 Phase 2: 触发 Executor 补充技术实现细节`);
    log(`${'═'.repeat(50)}`);

    const p1Content = readFileSafe(plannerOut);

    await sendToAgent(client, 'executor', 'discussion-phase2', `这是一次团队讨论任务。Planner 已制定了测试方案框架，现在需要你从技术实现角度补充细节。

Planner 的框架如下：
${p1Content.slice(0, 3000)}

你的任务：
1. 读取以下文件了解项目技术实现：
   - apps/server/package.json（依赖与脚本）
   - apps/editor/package.json
   - packages/schema/src/ 目录
   - test/ 目录（看现有测试结构）

2. 基于 Planner 的框架，补充具体技术内容：
   a. 每类测试的具体实现方式（代码结构示例）
   b. 推荐的测试工具版本与安装命令
   c. 具体测试脚本的执行命令（npm run test:xxx）
   d. CI/CD 集成建议（如何加入 package.json scripts）
   e. 可直接运行的第一个冒烟测试脚本示例

3. 将补充内容写入文件：memory/discussion/02-executor.md
   - 每个建议都要有可执行的命令或代码片段
   - 文件写完后最后一行写：<!-- DONE -->

完成后等待 Critic 审查。`
    );

    log(`⏳ 等待 Executor 完成写入（最长 8 分钟）...`);
    const executorContent = await waitForFile(executorOut, PHASE_TIMEOUT_MS);
    if (!executorContent) {
      log(`⚠️ Executor 超时未完成写入，使用占位内容继续`);
      fs.writeFileSync(executorOut, `# Executor 输出（超时）\n\n未能在 8 分钟内获得输出。\n<!-- DONE -->\n`);
    } else {
      log(`✅ Executor 完成！输出 ${executorContent.length} 字`);
      writeSection('Phase 2 - Executor 技术细节', executorContent);
    }

    // ── Phase 3: Critic ─────────────────────────────────────────────────
    phaseLabel = 'Phase 3 - Critic 审查与风险评估';
    log(`\n${'═'.repeat(50)}`);
    log(`🔍 Phase 3: 触发 Critic 审查测试方案`);
    log(`${'═'.repeat(50)}`);

    const p2Content = readFileSafe(executorOut);

    await sendToAgent(client, 'critic', 'discussion-phase3', `这是一次团队讨论任务。请审查 Planner 和 Executor 提出的测试方案，找出缺漏与风险。

Planner 框架（摘要）：
${p1Content.slice(0, 1500)}

Executor 技术补充（摘要）：
${p2Content.slice(0, 1500)}

你的任务（严格审查，给出 FAIL 或 PASS）：

1. 验收标准检查：
   a. 是否覆盖了核心生产链路的所有关键节点？
   b. 测试优先级（P0/P1/P2）是否合理？
   c. 技术方案是否可行且可执行？
   d. 是否有明显遗漏的测试场景？

2. 风险识别：
   a. 哪些测试方案执行成本高但收益低？
   b. 哪里有潜在的测试维护负担？
   c. 工具选型有没有兼容性风险？

3. 补充建议：
   a. 必须补充的测试场景（如有）
   b. 建议删除或简化的部分
   c. 最短路径：如果只能做一件事，应该先做什么？

4. 将审查结果写入文件：memory/discussion/03-critic.md
   - 格式：PASS/FAIL 结论放第一行
   - 分级列出发现（[严重]/[警告]/[建议]）
   - 末尾写最终建议的"最小可行测试套件"（3-5 个测试用例）
   - 文件写完后最后一行写：<!-- DONE -->

审查完成后，等待 Reporter 整合。`
    );

    log(`⏳ 等待 Critic 完成写入（最长 8 分钟）...`);
    const criticContent = await waitForFile(criticOut, PHASE_TIMEOUT_MS);
    if (!criticContent) {
      log(`⚠️ Critic 超时未完成写入，使用占位内容继续`);
      fs.writeFileSync(criticOut, `# Critic 输出（超时）\n\n未能在 8 分钟内获得输出。\n<!-- DONE -->\n`);
    } else {
      log(`✅ Critic 完成！输出 ${criticContent.length} 字`);
      writeSection('Phase 3 - Critic 审查', criticContent);
    }

    // ── Phase 4: Reporter ───────────────────────────────────────────────
    phaseLabel = 'Phase 4 - Reporter 汇总结束';
    clearInterval(reporterTimer); // 停止定时汇报
    log(`\n${'═'.repeat(50)}`);
    log(`📢 Phase 4: 触发 Reporter 最终汇总与邮件`);
    log(`${'═'.repeat(50)}`);

    const p3Content = readFileSafe(criticOut);

    await sendToAgent(client, 'reporter', 'discussion-final', `老板好！团队讨论已全部完成，请你做最终汇总和邮件发送。

本次讨论主题：为 GameStudio 项目打造基础测试方案

各代理贡献摘要：

【Planner 框架】
${p1Content.slice(0, 1200)}

【Executor 技术细节】
${p2Content.slice(0, 1200)}

【Critic 审查结论】
${p3Content.slice(0, 1200)}

你的任务：
1. 将以上内容整合为完整的"团队讨论最终报告"
2. 将报告写入 memory/discussion/04-reporter.md
   结构如下：
   - 执行摘要（3-5句话说清楚做了什么，得出了什么结论）
   - 最终建议的测试方案（来自各代理的共识）
   - 行动清单（按优先级排列的下一步行动）
   - Critic 评级：PASS/FAIL

3. 发送最终汇报邮件（bash scripts/lifecycle/reporter_email.sh）

4. 将讨论记录写入今日日志（memory/${dateStr}.md）

5. 文件最后一行写：<!-- DONE -->

开头说"老板好！"，结尾说"讨论汇报完毕！随时吩咐～😊"`
    );

    log(`⏳ 等待 Reporter 完成最终汇总（最长 8 分钟）...`);
    const reporterContent = await waitForFile(reporterOut, PHASE_TIMEOUT_MS);
    if (!reporterContent) {
      log(`⚠️ Reporter 超时未完成写入`);
    } else {
      log(`✅ Reporter 完成！输出 ${reporterContent.length} 字`);
      writeSection('Phase 4 - Reporter 最终报告', reporterContent);
    }

    // ── 编译最终日志 ────────────────────────────────────────────────────
    log(`\n${'═'.repeat(50)}`);
    log(`📄 编译最终讨论记录`);
    fs.appendFileSync(masterLogFile, `\n\n---\n记录生成时间：${new Date().toISOString()}\n讨论文件目录：${discussionDir}\n`);
    log(`✅ 完整讨论记录已保存至: memory/${dateStr}-discussion.md`);
    log(`✅ 各代理输出文件在: memory/discussion/`);
    log(`🏁 多代理团队讨论测试完成！`);

  } finally {
    clearInterval(reporterTimer);
    client.close();
  }
}

main().catch(err => {
  console.error(`[discussion] 失败: ${err.message}`);
  process.exit(1);
});
