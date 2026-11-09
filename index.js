// Provider-scoped tunnel for OpenRouter.
//
// Why this plugin exists: dsh-llm-pi-ai has no per-provider `proxy` field, and a
// process-wide HTTPS_PROXY would pull every provider through the VPN. Instead the
// `openrouter` route's baseURL points at this loopback forwarder, and the
// forwarder decides per request:
//
//   openai/*, anthropic/*, google/*  -> local VPN HTTP proxy
//   everything else                   -> direct
//
// Why curl is the transport: on this machine a Node TLS connection to
// openrouter.ai through the same VPN lands on a different Cloudflare edge and is
// rejected with 403 "not available in your region", while curl through the same
// VPN proxy succeeds. curl also streams SSE without buffering.
//
// The forwarder lives in the Host process: it starts with the plugin and closes
// with it, so there is no launchd service and nothing to start by hand.

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'provider-tunnel';
export const inject = ['llm'];

// 配置表单：Settings/Plugin Manager 会按这个 schema 渲染字段，用户改完即写回
// 本插件的 row，插件重启后用新值。schema 不可用时插件照常激活。
let Config;
try {
  const { default: Schema } = await import('@deepseek-ai/schemastery');
  Config = Schema.object({
    port: Schema.natural().default(8787).description('转发器监听端口；被占用时自动顺延最多 10 个。provider 的 baseURL 必须指向实际端口。'),
    vpnProxy: Schema.string().default('127.0.0.1:7897').description('VPN 的本地 HTTP 代理，格式 host:port。切换或更新 VPN 后在这里改。'),
    vpnProviders: Schema.array(Schema.string()).default(DEFAULT_VPN_PROVIDERS).description('必须走 VPN 的厂商前缀，对应模型 id 里 / 之前那段。'),
    vpnModelIds: Schema.array(Schema.string()).default([]).description('额外点名必须走 VPN 的模型 id，优先级高于厂商前缀。'),
    upstream: Schema.string().default('openrouter.ai').description('默认上游主机名（未加 /p/<provider> 前缀时使用）。'),
    upstreams: Schema.dict(Schema.string()).default({ openrouter: 'openrouter.ai' }).description('provider id → 上游主机名；请求路径写成 /p/<provider>/<原路径> 时按它转发。'),
  });
} catch {}

export { Config };

const DEFAULTS = {
  port: 0,
  vpnProxy: '127.0.0.1:7897',
  vpnModels: '^(openai|anthropic|google)/',
  upstream: 'openrouter.ai',
  upstreams: { openrouter: 'openrouter.ai' },
};

const DROP_HEADERS = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'user-agent', 'expect']);

function headerLines(headers) {
  const lines = [];
  for (const [key, value] of Object.entries(headers)) {
    if (DROP_HEADERS.has(key.toLowerCase())) continue;
    for (const one of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${one}`);
  }
  return lines;
}

function modelOf(url, body) {
  if (!/\/(chat\/completions|responses|messages)$/.test(url) || body.length === 0) return '';
  try {
    return String(JSON.parse(body.toString('utf8')).model ?? '');
  } catch {
    return '';
  }
}

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config };
  settings.vpnProxy = String(settings.vpnProxy).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const port = Number(settings.port);
  const vpnProviders = Array.isArray(settings.vpnProviders) ? settings.vpnProviders : DEFAULT_VPN_PROVIDERS;
  const vpnModelIds = Array.isArray(settings.vpnModelIds) ? settings.vpnModelIds : [];
  // 选中模型列表是唯一事实来源；vpnProviders 只在旧配置没有模型列表时作为默认值。
  const needsVpn = (model) => {
    if (!model) return false;
    if (vpnModelIds.length > 0) return vpnModelIds.includes(model);
    const vendor = model.includes('/') ? model.slice(0, model.indexOf('/')) : model;
    return vpnProviders.includes(vendor);
  };
  const logFile = path.join(os.homedir(), '.dsh', 'provider-tunnel.log');
  const log = (message) => {
    const line = `${new Date().toISOString()} ${message}\n`;
    try { fs.appendFileSync(logFile, line); } catch {}
    const logger = ctx.get?.('logger');
    if (logger?.info) logger.info(`[provider-tunnel] ${message}`);
  };

  // 路径 /p/<provider>/<rest> 指定 provider；不带前缀时回落到默认 upstream。
  const resolveRoute = (url) => {
    const match = /^\/p\/([^/]+)(\/.*)?$/.exec(url);
    if (match) {
      const provider = match[1];
      const host = settings.upstreams?.[provider];
      if (!host) return { provider, host: '', path: url, unknown: true };
      return { provider, host, path: match[2] && match[2].length > 0 ? match[2] : '/', unknown: false };
    }
    return { provider: 'openrouter', host: settings.upstream, path: url, unknown: false };
  };

  let lastRoute = null;
  let actualPort = port;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', () => {});
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const routeInfo = resolveRoute(req.url);
      if (routeInfo.unknown) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown provider', provider: routeInfo.provider }));
        return;
      }
      const model = modelOf(routeInfo.path, body);
      const viaVpn = needsVpn(model);

      const args = [
        '-sS', '-N', '--http2', '--suppress-connect-headers',
        '-X', req.method,
        `https://${routeInfo.host}${routeInfo.path}`,
        '-D', '-',
        '-A', 'dsh-provider-tunnel/1.0',
      ];
      if (viaVpn) args.push('-x', settings.vpnProxy);
      for (const line of headerLines(req.headers)) args.push('-H', line);

      let tempFile = '';
      if (body.length > 0) {
        tempFile = path.join(os.tmpdir(), `dsh-tunnel-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
        fs.writeFileSync(tempFile, body);
        args.push('--data-binary', `@${tempFile}`);
      }

      const cleanup = () => {
        if (tempFile) fs.rm(tempFile, { force: true }, () => {});
      };

      const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let headerBuffer = Buffer.alloc(0);
      let headersDone = false;
      let responded = false;
      let closed = false;

      child.stdout.on('data', (chunk) => {
        if (headersDone) {
          res.write(chunk);
          return;
        }
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        const split = headerBuffer.indexOf('\r\n\r\n');
        if (split === -1) return;

        const head = headerBuffer.subarray(0, split).toString('utf8');
        const rest = headerBuffer.subarray(split + 4);
        headersDone = true;

        const lines = head.split('\r\n');
        const statusMatch = /^HTTP\/[\d.]+ (\d{3})/.exec(lines[0] ?? '');
        const status = statusMatch ? Number(statusMatch[1]) : 502;
        const out = { 'x-local-route': viaVpn ? 'vpn' : 'direct' };
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(':');
          if (colon === -1) continue;
          const key = line.slice(0, colon).trim().toLowerCase();
          const value = line.slice(colon + 1).trim();
          if (DROP_HEADERS.has(key) || key === 'transfer-encoding' || key === 'content-encoding') continue;
          out[key] = value;
        }
        responded = true;
        res.writeHead(status, out);
        if (rest.length > 0) res.write(rest);
        lastRoute = `${routeInfo.provider} · ${model || req.method} → ${viaVpn ? 'vpn' : 'direct'} (${status})`;
        log(`${req.method} ${routeInfo.path} provider=${routeInfo.provider} model=${model || '-'} route=${viaVpn ? 'vpn' : 'direct'} status=${status}`);
      });

      child.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text) log(`curl: ${text}`);
      });

      child.on('error', (error) => {
        if (!responded) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'curl_spawn_failed', detail: error.message }));
        } else {
          res.end();
        }
        cleanup();
      });

      child.on('close', (code) => {
        if (!closed) {
          closed = true;
          if (!responded) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'upstream_failed', exit: code }));
          } else {
            res.end();
          }
        }
        cleanup();
      });

      res.on('close', () => {
        if (!closed) {
          closed = true;
          child.kill('SIGTERM');
          cleanup();
        }
      });
    });
  });

  server.requestTimeout = 0;
  server.headersTimeout = 0;

  // 端口从配置里的 port 开始，被占用就往后找最多 10 个；实际端口写进日志。
  // 插件无法改 provider 的 baseURL：configEditor 在插件激活/HMR 事务内不可用。
  const bind = (candidate, remaining) => new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      if (error.code === 'EADDRINUSE' && remaining > 0) resolve(bind(candidate + 1, remaining - 1));
      else reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(candidate, '127.0.0.1');
  });

  const listening = bind(port, 10);

  ctx.effect(() => () => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  }));

  // 人类命令：切换 VPN 代理，避免手改 profile。（/vpn 查看，/vpn host:port 设置）
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.effect(() => cmdCtx.commands.register({
      name: 'vpn',
      description: 'Show or set the OpenRouter tunnel VPN proxy (host:port)',
      handler: async (invocation) => {
        const raw = String(invocation?.rawInput ?? '').trim();
        if (raw === '') return { kind: 'success', text: `vpnProxy = ${settings.vpnProxy}（用 /vpn host:port 修改）` };
        const next = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
        if (!/^[^:\s]+:\d+$/.test(next)) return { kind: 'error', text: `格式应为 host:port，收到：${raw}` };
        const editor = ctx.get?.('configEditor');
        const entry = ctx.fiber?.entry;
        if (editor === undefined || entry === undefined) return { kind: 'error', text: '当前 profile 不支持写入配置' };
        try {
          await editor.edit(entry, (current) => ({ ...current, vpnProxy: next }));
        } catch (error) {
          return { kind: 'error', text: `写入失败：${error?.message ?? error}` };
        }
        return { kind: 'success', text: `vpnProxy 已更新为 ${next}，插件重启后生效` };
      },
    }), 'provider-tunnel: /vpn');
  });


  // 设置页表单用的两个本机端点：读状态、写 vpnProxy。
  // 写操作必须等响应发出去再改配置——改自己的 row 会让本插件重启、连接被切断。
  const readJson = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/provider-tunnel/state',
      handler: async (req, res) => {
        const groups = [];
        try {
          const editor = ctx.get?.('configEditor');
          const entry = editor?.entries()?.find((candidate) => candidate?.options?.id === 'llm-pi-ai');
          const providers = entry?.options?.config?.providers ?? {};
          for (const [provider, config] of Object.entries(providers)) {
            const models = (config?.models ?? []).map((model) => String(model?.id ?? '')).filter(Boolean);
            if (models.length > 0) groups.push({ provider, models });
          }
        } catch (error) {
          log(`cannot read provider models: ${error?.message ?? error}`);
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({
          vpnProxy: settings.vpnProxy,
          vpnProviders,
          vpnModelIds,
          upstream: settings.upstream,
          port: actualPort,
          lastRoute,
          upstreams: settings.upstreams ?? {},
          groups,
        }));
      },
    }), 'provider-tunnel: GET /provider-tunnel/state');

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/provider-tunnel/vpnProxy',
      handler: async (req, res) => {
        const send = (status, payload) => {
          res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify(payload));
        };
        if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' });
        let body;
        try { body = await readJson(req); } catch { return send(400, { ok: false, error: 'invalid JSON' }); }

        const nextProxy = String(body?.vpnProxy ?? settings.vpnProxy).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
        if (!/^[^:\s]+:\d+$/.test(nextProxy)) return send(400, { ok: false, error: '代理地址格式应为 host:port' });
        const nextProviders = Array.isArray(body?.vpnProviders)
          ? body.vpnProviders.map((item) => String(item).trim()).filter((item) => item.length > 0)
          : vpnProviders;
        const nextModelIds = Array.isArray(body?.vpnModelIds)
          ? body.vpnModelIds.map((item) => String(item).trim()).filter((item) => item.length > 0)
          : vpnModelIds;

        const editor = ctx.get?.('configEditor');
        const entry = ctx.fiber?.entry;
        if (editor === undefined || entry === undefined) return send(500, { ok: false, error: '当前 profile 不支持写配置' });
        send(200, { ok: true, vpnProxy: nextProxy, vpnProviders: nextProviders, vpnModelIds: nextModelIds });
        setTimeout(() => {
          editor.edit(entry, (current) => ({
            ...current,
            vpnProxy: nextProxy,
            vpnProviders: nextProviders,
            vpnModelIds: nextModelIds,
          }))
            .then(() => log(`配置已更新：${nextProxy} · providers=${nextProviders.join(',')} · models=${nextModelIds.length}`))
            .catch((error) => log(`配置写入失败: ${error?.message ?? error}`));
        }, 250);
      },
    }), 'provider-tunnel: POST /provider-tunnel/vpnProxy');
  });

  listening.then(
    (boundPort) => {
      actualPort = boundPort;
      log(`listening on 127.0.0.1:${boundPort} -> https://${settings.upstream} (vpn: ${vpnProviders.join(',')})`);
      if (boundPort !== port) log(`port ${port} was busy; provider baseURL must be http://127.0.0.1:${boundPort}/api/v1`);
    },
    (error) => log(`failed to listen from port ${port}: ${error?.message ?? error}`),
  );
}
