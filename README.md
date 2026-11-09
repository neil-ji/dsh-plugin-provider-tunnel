# dsh-plugin-provider-tunnel

A DeepSeek Harness (DSH) plugin that puts a **provider-scoped tunnel** in front of model providers, so only the models you choose go through a local VPN (or any HTTP proxy) while everything else stays direct.

## Why

`dsh-llm-pi-ai` has no per-provider `proxy` field, and a process-wide `HTTPS_PROXY` pulls every provider into the VPN. Patching `globalThis.fetch` couples a plugin to an implementation detail. This plugin takes the remaining supported seam: a provider route's `baseURL` points at a loopback forwarder owned by the plugin, and the forwarder decides per request.

## What it does

- One loopback HTTP forwarder, started and stopped with the plugin (no launchd, no separate daemon).
- Requests are matched by model id against an explicit allowlist; matches are sent through your local proxy, everything else goes direct.
- Works for **any provider**, addressed by path: `http://127.0.0.1:<port>/p/<provider>/<original path>` is forwarded to `https://<upstream for that provider>/<original path>`.
- A settings page (**Settings → Provider tunnel**) lists every provider and model read from your profile, with tri-state checkboxes:

| Action | Result |
| --- | --- |
| Check a provider | all of its models selected |
| Uncheck one model | only that model leaves the VPN; the provider shows as partial |
| Check one model | the provider shows as partial until every model is selected |
| Save | writes the explicit model list; nothing else is inferred |

- A `/vpn` chat command shows or sets the proxy: `/vpn host:port`.

## Install

```bash
# from a checkout, with the plugin manager available
plugin_manager install_bundle /absolute/path/to/dsh-plugin-provider-tunnel
```

Then point the routes you want tunnelled at it.

### Route setup

| Provider | `baseURL` |
| --- | --- |
| `openrouter` | `http://127.0.0.1:8787/api/v1` (no prefix needed) |
| any other | `http://127.0.0.1:8787/p/<provider>/<original base path>` |

For example, to tunnel `zai` as well:

```yaml
providers:
  zai:
    apiKeyEnv: ZAI_API_KEY
    baseURL: http://127.0.0.1:8787/p/zai/api/paas/v4
    models: [ ... ]
```

and add the upstream to the plugin config:

```yaml
- id: provider-tunnel
  name: 'dsh-plugin-provider-tunnel'
  config:
    port: 8787
    vpnProxy: 127.0.0.1:7897
    upstreams:
      openrouter: openrouter.ai
      zai: api.z.ai
```

Requests without a `/p/<provider>` prefix use `upstream` (default `openrouter.ai`), so an existing single-provider setup keeps working.

## Config

| Field | Default | Meaning |
| --- | --- | --- |
| `port` | `8787` | Loopback port; if busy it moves forward up to ten ports and logs the one it got |
| `vpnProxy` | `127.0.0.1:7897` | Local VPN HTTP proxy, `host:port` |
| `upstream` | `openrouter.ai` | Upstream for unprefixed requests |
| `upstreams` | `{ openrouter: openrouter.ai }` | `provider → host` for prefixed requests |
| `vpnProviders` | `[openai, anthropic, google]` | Legacy fallback: vendor prefixes, used only while no explicit model list exists |
| `vpnModelIds` | `[]` | Explicit models that must use the proxy; this is what the settings page writes |

Responses carry `x-local-route: vpn|direct` for diagnostics, and every request is logged to `~/.dsh/provider-tunnel.log`.

## Why curl is the transport

On macOS, a Node TLS connection to some providers through the same VPN lands on a different Cloudflare edge and is rejected with *"This model is not available in your region"*, while `curl` through the same proxy succeeds. curl also streams SSE without buffering. The forwarder therefore shells out to curl per request instead of using Node's HTTP client.

## Limitations

- A plugin cannot rewrite a provider's `baseURL` itself: `configEditor` is refused inside the HMR transaction a plugin activates in. The profile keeps one `baseURL` line per tunnelled provider, and the plugin logs the real port if 8787 was busy.
- The port is fixed (8787) rather than ephemeral, because an ephemeral port would require writing the profile on every start, which the same HMR guard prevents.

## License

MIT
