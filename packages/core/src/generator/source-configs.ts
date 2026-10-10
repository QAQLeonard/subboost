import type { ParsedNode } from "../types/node";
import { getNodeOriginName, getNodeSourceIds } from "../subscription/node-source-state";

export interface SourceClashConfig { id: string; config: Record<string, unknown>; resolvedHosts?: Record<string, string[]> }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const BUILTIN_POLICIES = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]);
const MANAGED_SECTIONS = new Set(["proxies", "proxy-groups", "rules", "sub-rules", "proxy-providers", "rule-providers"]);

function sourcePolicy(sourceId: string, nodes: ParsedNode[]) {
  const names = new Map(nodes.filter(node => getNodeSourceIds(node).includes(sourceId))
    .map(node => [getNodeOriginName(node), node.name]));
  return (name: string) => BUILTIN_POLICIES.has(name) ? name : names.get(name);
}

// Subscription order resolves collisions; explicit SubBoost settings take precedence.
function merge(left: unknown, right: unknown): unknown {
  if (record(left) && record(right)) {
    const out = structuredClone(left);
    for (const [key, value] of Object.entries(right)) out[key] = key in out ? merge(out[key], value) : structuredClone(value);
    return out;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const seen = new Set<string>();
    return [...left, ...right].filter(value => { const key = JSON.stringify(value); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  return structuredClone(right);
}

// Imported providers feed SubBoost's own groups; upstream groups and rules are never exported.
export function buildSourceProxyProviders(sources: SourceClashConfig[], nodes: ParsedNode[]): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const source of sources) {
    const raw = source.config["proxy-providers"];
    if (!record(raw)) continue;
    const policy = sourcePolicy(source.id, nodes);
    for (const [name, value] of Object.entries(raw)) {
      if (!record(value)) continue;
      const provider = structuredClone(value);
      if (typeof provider.proxy === "string") {
        const target = policy(provider.proxy);
        if (target) provider.proxy = target;
        else delete provider.proxy;
      }
      if (provider.type === "http") {
        provider.path = `./source_providers/${source.id.replace(/[^a-zA-Z0-9_-]/g, "_")}_${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.yaml`;
      }
      providers[`source:${source.id}:${name}`] = provider;
    }
  }
  return providers;
}

export function mergeSourceClashConfigs(generated: Record<string, unknown>, sources: SourceClashConfig[], nodes: ParsedNode[]): Record<string, unknown> {
  if (!sources.length) return generated;
  let base: Record<string, unknown> = {};
  const localDnsPorts = new Set<string>();

  for (const source of sources) {
    const config = source.config;
    const policy = sourcePolicy(source.id, nodes);

    if (record(config.dns) && typeof config.dns.listen === "string") {
      const port = config.dns.listen.match(/:(\d+)$/)?.[1];
      if (port) localDnsPorts.add(port);
    }
    const metadata = Object.fromEntries(Object.entries(config).filter(([key]) => !MANAGED_SECTIONS.has(key)));
    if (Array.isArray(metadata.listeners)) {
      metadata.listeners = metadata.listeners.flatMap(listener => {
        if (!record(listener) || typeof listener.proxy !== "string") return [listener];
        const target = policy(listener.proxy);
        return target ? [{ ...listener, proxy: target }] : [];
      });
    }
    base = merge(metadata, base) as Record<string, unknown>;
  }
  const result = merge(base, generated) as Record<string, unknown>;
  // Keep original aliases in the snapshot, but export IP hosts entries so clients do
  // not need a separate domain-alias resolver or rely on a rewritten DNS section.
  if (record(result.hosts)) {
    for (const source of [...sources].reverse()) {
      const originalHosts = record(source.config.hosts) ? source.config.hosts : {};
      for (const [name, addresses] of Object.entries(source.resolvedHosts ?? {})) {
        if (addresses.length && JSON.stringify(result.hosts[name]) === JSON.stringify(originalHosts[name])) {
          result.hosts[name] = addresses;
        }
        // A client parser may restore the original domain alias. Also close the
        // alias chain with an IP entry, which Mihomo's outbound resolver follows
        // independently of the client's DNS settings.
        let target = originalHosts[name];
        const visited = new Set([name]);
        while (typeof target === "string" && !target.includes(":") && !/^\d+\.\d+\.\d+\.\d+$/.test(target) && !visited.has(target)) {
          visited.add(target);
          const next = originalHosts[target];
          if (next !== undefined) { target = next; continue; }
          if (addresses.length && result.hosts[target] === undefined) result.hosts[target] = addresses;
          break;
        }
      }
    }
  }
  if (record(result.hosts) && Object.keys(result.hosts).length && record(result.dns)) result.dns["use-hosts"] = true;
  // A client's DNS listener may return fake-IP answers. Never use it to resolve proxy entries.
  if (record(result.dns) && Array.isArray(result.dns["proxy-server-nameserver"])) {
    const dns = result.dns;
    const port = typeof dns.listen === "string" ? dns.listen.match(/:(\d+)$/)?.[1] : undefined;
    if (port) localDnsPorts.add(port);
    const upstreams = result.dns["proxy-server-nameserver"].filter(server => {
      if (typeof server !== "string") return true;
      try {
        const target = new URL(server.includes("://") ? server : "udp://" + server);
        const host = target.hostname.replace(/^\[|\]$/g, "");
        return !["localhost", "127.0.0.1", "0.0.0.0", "::", "::1"].includes(host)
          || !localDnsPorts.has(target.port || "53");
      } catch { return true; }
    });
    if (upstreams.length) dns["proxy-server-nameserver"] = upstreams;
    else delete dns["proxy-server-nameserver"];
  }
  return result;
}
