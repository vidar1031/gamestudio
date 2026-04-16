#!/usr/bin/env node
/*
 * Team check-in for OpenClaw startup.
 * Creates/activates main sessions for planner/executor/critic/reporter
 * and sends one short check-in message to each agent.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectDir = path.resolve(__dirname, '..', '..');
const runDir = path.join(projectDir, '.run');
const lockPath = path.join(runDir, 'team_checkin.lock');
const staleMs = Number(process.env.TEAM_CHECKIN_STALE_MS || 120000);

const monitorNodeModules = path.join(projectDir, 'monitor', 'openclaw', 'node_modules');
const wsModulePath = path.join(monitorNodeModules, 'ws');
const sodiumModulePath = path.join(monitorNodeModules, 'sodium-native');

function requireFrom(modulePath, moduleName) {
  try {
    return require(modulePath);
  } catch (err) {
    throw new Error(`missing dependency ${moduleName}; run: cd monitor/openclaw && npm install`);
  }
}

const WebSocket = requireFrom(wsModulePath, 'ws');
const sodium = requireFrom(sodiumModulePath, 'sodium-native');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function now() {
  return Date.now();
}

function withLock() {
  ensureDir(runDir);
  const ts = now();
  if (fs.existsSync(lockPath)) {
    const prev = Number(fs.readFileSync(lockPath, 'utf-8').trim() || '0');
    if (Number.isFinite(prev) && ts - prev < staleMs) {
      console.log(`[team-checkin] skip: lock active (${Math.round((ts - prev) / 1000)}s ago)`);
      process.exit(0);
    }
  }
  fs.writeFileSync(lockPath, String(ts));
}

function loadJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function loadOpenClawConfig() {
  const candidates = [
    path.join(process.env.HOME || '', '.openclaw', 'openclaw.json'),
    '/Volumes/ovokit2t/AIOVO/home/.openclaw/openclaw.json'
  ];
  for (const file of candidates) {
    if (!file) continue;
    if (!fs.existsSync(file)) continue;
    const cfg = loadJson(file, {});
    if (cfg && typeof cfg === 'object') return cfg;
  }
  return {};
}

function toUrlSafeBase64(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function loadOrCreateIdentity(identityPath) {
  if (fs.existsSync(identityPath)) {
    const data = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
    return {
      deviceId: data.deviceId,
      publicKey: Buffer.from(data.publicKey, 'base64'),
      privateKey: Buffer.from(data.privateKey, 'base64')
    };
  }

  const publicKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
  const privateKey = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
  sodium.crypto_sign_keypair(publicKey, privateKey);
  const deviceId = crypto.createHash('sha256').update(publicKey).digest('hex');

  fs.writeFileSync(identityPath, JSON.stringify({
    deviceId,
    publicKey: publicKey.toString('base64'),
    privateKey: privateKey.toString('base64')
  }, null, 2));

  return { deviceId, publicKey, privateKey };
}

class RpcClient {
  constructor({ wsUrl, gatewayToken, identity, origin }) {
    this.wsUrl = wsUrl;
    this.gatewayToken = gatewayToken;
    this.identity = identity;
    this.origin = origin;
    this.ws = null;
    this.reqId = 0;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl, {
        handshakeTimeout: 15000,
        headers: {
          Origin: this.origin
        }
      });

      this.ws.on('open', () => {
        // wait challenge
      });

      this.ws.on('error', (err) => {
        reject(err);
      });

      this.ws.on('message', (data) => {
        this.onMessage(data, resolve, reject);
      });

      this.ws.on('close', () => {
        for (const [id, p] of this.pending.entries()) {
          clearTimeout(p.timer);
          p.reject(new Error(`socket closed while waiting response for ${id}`));
          this.pending.delete(id);
        }
      });
    });
  }

  onMessage(data, resolveConnect, rejectConnect) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      try {
        const nonce = msg.payload?.nonce;
        if (!nonce) throw new Error('connect.challenge missing nonce');

        const clientId = 'openclaw-control-ui';
        const clientMode = 'ui';
        const role = 'operator';
        const scopes = ['operator.admin', 'operator.read', 'operator.write'];
        const signedAt = Date.now();

        const sigString = `v2|${this.identity.deviceId}|${clientId}|${clientMode}|${role}|${scopes.join(',')}|${signedAt}|${this.gatewayToken || ''}|${nonce}`;
        const signature = Buffer.alloc(sodium.crypto_sign_BYTES);
        sodium.crypto_sign_detached(signature, Buffer.from(sigString), this.identity.privateKey);

        this.ws.send(JSON.stringify({
          type: 'req',
          id: 'connect-auth',
          method: 'connect',
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: clientId,
              version: '1.0.0',
              platform: process.platform,
              mode: clientMode
            },
            role,
            scopes,
            device: {
              id: this.identity.deviceId,
              publicKey: toUrlSafeBase64(this.identity.publicKey),
              signature: toUrlSafeBase64(signature),
              signedAt,
              nonce
            },
            caps: ['tool-events'],
            auth: {
              token: this.gatewayToken || '',
              password: ''
            }
          }
        }));
      } catch (err) {
        rejectConnect(err);
      }
      return;
    }

    if (msg.type === 'res' && msg.id === 'connect-auth') {
      if (msg.ok) {
        resolveConnect(msg.payload);
      } else {
        const err = typeof msg.error === 'object' ? msg.error?.message : msg.error;
        rejectConnect(new Error(`connect failed: ${err || 'unknown error'}`));
      }
      return;
    }

    if (msg.type === 'res' && msg.id) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.ok) {
        pending.resolve(msg.payload);
      } else {
        const err = typeof msg.error === 'object' ? msg.error?.message : msg.error;
        pending.reject(new Error(err || 'rpc failed'));
      }
    }
  }

  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('websocket not connected'));
        return;
      }
      const id = `req-${++this.reqId}-${Date.now()}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }
}

async function main() {
  withLock();

  const openclawConfig = loadOpenClawConfig();
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || openclawConfig.gateway?.auth?.token || '';
  const wsUrl = process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789';
  const wsOrigin = process.env.OPENCLAW_GATEWAY_ORIGIN || 'http://127.0.0.1:18789';

  const identityPath = path.join(projectDir, 'monitor', 'openclaw', '.device_identity.json');
  const identity = loadOrCreateIdentity(identityPath);

  const agents = [
    { id: 'planner', msg: '📋 Planner 已上线。准备进行任务规划与协调。' },
    { id: 'executor', msg: '🔧 Executor 已上线。准备执行代码修改与验证。' },
    { id: 'critic', msg: '🔍 Critic 已上线。准备进行审查与风险把控。' },
    { id: 'reporter', msg: '📢 Reporter 已上线。准备执行启动汇报与状态播报。' }
  ];

  const client = new RpcClient({ wsUrl, gatewayToken, identity, origin: wsOrigin });

  try {
    await client.connect();

    for (const agent of agents) {
      const created = await client.send('sessions.create', {
        agentId: agent.id,
        key: 'main',
        label: 'main',
        message: `你现在是${agent.id}。请用一句话完成团队启动签到：${agent.msg}`
      });
      const key = created?.key || `agent:${agent.id}:main`;
      console.log(`[team-checkin] ${agent.id} ready via ${key}`);
    }

    console.log('[team-checkin] completed');
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(`[team-checkin] failed: ${err.message}`);
  process.exit(1);
});
