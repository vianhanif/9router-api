/**
 * Headroom compression shim for 9router-api.
 *
 * 9router's open-sse/rtk/headroom.js compresses chat bodies by POSTing to
 * `{headroomUrl}/v1/compress` — the HTTP contract of headroom-ai < 0.5.
 * headroom-ai 0.5.x removed that endpoint from the proxy (the proxy banner
 * now only exposes /health, /stats, /metrics, /v1/messages,
 * /v1/chat/completions, ...), so every compression call in the API server
 * failed open with HTTP 404 and headroom silently stopped compressing
 * (evidence: `skipped: proxy returned HTTP 404 (http://localhost:8787/v1/compress)`
 * in ~/.9router/9r-api-error.log).
 *
 * The removed endpoint's contract still exists in headroom-ai as the Python
 * library function `headroom.compress.compress(messages, model=...)`, which
 * returns the exact same shape (`messages`, `tokens_before`, `tokens_after`,
 * `tokens_saved`). This module re-implements `/v1/compress` in-process by
 * intercepting the core's fetch call and delegating to that library.
 *
 * Fail-open by design: any failure (no Python, headroom-ai missing, timeout,
 * bad payload) returns the ORIGINAL messages with zero token stats so the
 * 9router core continues with an unchanged request body, mirroring the old
 * proxy's graceful-degradation behavior.
 *
 * This is 9router-api-owned enhancement layer code. 9router core is never
 * modified.
 */

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { DEFAULT_HEADROOM_URL, findPython310, getSettings, isLoopbackHeadroomUrl } from "./exports.js";

// Per-request budget covering BOTH the worker READY wait and the compression
// call. The one-time Python import cost (headroom-ai pulls in its full
// transforms pipeline, ~5s) is paid once when the worker is prewarmed (only
// when headroom is enabled at a loopback URL), so warm requests answer well
// within this budget; a slow/unhealthy worker that never becomes ready also
// fails open inside it. The core's 3s AbortSignal.timeout is passed to the
// real fetch we never make, so it does not bound our handler.
const DEFAULT_TIMEOUT_MS = 5000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
const COMPRESS_SUFFIX = "/v1/compress";

// Persistent Python worker: reads {id, messages, model} lines from stdin,
// calls the headroom-ai library, prints the old /v1/compress JSON contract
// back as a {id, ok, ...} line. headroom.compress already fails open
// internally; we also guard the whole worker so a broken install can never
// crash the API server. The worker exits on stdin EOF, so when the parent
// dies its stdin pipe closes and the worker self-terminates (no orphans).
const PYTHON_WORKER = `
import json, sys, traceback

try:
    from headroom.transforms.pipeline import TransformPipeline
    from headroom.transforms.content_router import ContentRouter
except Exception:
    sys.stderr.write("HEADROOM_COMPRESS_SHIM_ERROR: headroom import failed\\n" + traceback.format_exc())
    sys.exit(3)

def reply(req_id, obj):
    print(json.dumps({"id": req_id, **obj}), flush=True)

def do_compress(messages, model, compress_user_messages=False, model_limit=200000):
    # headroom.compress.compress() builds TransformPipeline() which uses a
    # ContentRouter with default config, and the default protects user messages
    # (ContentRouterConfig.skip_user_messages=True). The old /v1/compress proxy
    # honored payload.config.compress_user_messages, so mirror that here by
    # toggling the router's skip_user_messages for this request. Requests are
    # serialized through the worker, so mutating the shared pipeline is safe.
    pipeline = TransformPipeline()
    for t in pipeline.transforms:
        if isinstance(t, ContentRouter):
            t.config.skip_user_messages = not compress_user_messages
    result = pipeline.apply(messages=messages, model=model, model_limit=model_limit)
    tokens_before = result.tokens_before
    tokens_after = result.tokens_after
    tokens_saved = tokens_before - tokens_after
    ratio = tokens_saved / tokens_before if tokens_before > 0 else 0.0
    return {
        "messages": result.messages,
        "tokens_before": tokens_before,
        "tokens_after": tokens_after,
        "tokens_saved": tokens_saved,
        "compression_ratio": ratio,
        "transforms_applied": result.transforms_applied,
    }

print("READY", flush=True)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        data = json.loads(line)
    except Exception:
        continue
    req_id = data.get("id")
    messages = data.get("messages") or []
    model = data.get("model") or "claude-sonnet-4-5-20250929"
    config = data.get("config") or {}
    compress_user = bool(config.get("compress_user_messages", False))
    try:
        reply(req_id, {"ok": True, **do_compress(messages, model, compress_user)})
    except Exception as e:
        # Fail-open exactly like headroom.compress does internally: return the
        # original messages with zero stats so the API body is unchanged.
        reply(req_id, {
            "ok": True,
            "messages": messages,
            "tokens_before": 0,
            "tokens_after": 0,
            "tokens_saved": 0,
            "compression_ratio": 0.0,
            "error": str(e),
        })
`;

let pythonCache: string | null | undefined;

function shimEnabled(): boolean {
  const raw = (process.env.HEADROOM_COMPRESS_SHIM || "").trim().toLowerCase();
  return raw === "" || raw === "on" || raw === "1" || raw === "true" || raw === "yes";
}

function shimTimeoutMs(): number {
  const raw = parseInt(process.env.HEADROOM_COMPRESS_TIMEOUT_MS || "", 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 60000);
  return DEFAULT_TIMEOUT_MS;
}

function shimDebug(): boolean {
  const raw = (process.env.HEADROOM_COMPRESS_SHIM_DEBUG || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

function explicitPythonWorks(py: string): boolean {
  try {
    execFileSync(py, ["--version"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function resolvePython(): Promise<string | null> {
  if (pythonCache !== undefined) return pythonCache;
  try {
    const explicit = (process.env.HEADROOM_PYTHON || "").trim();
    if (explicit) {
      // Trust an explicit HEADROOM_PYTHON only if it actually runs; cache the
      // negative too, so a bad path fails open immediately instead of letting
      // every request respawn a failing worker.
      pythonCache = explicitPythonWorks(explicit) ? explicit : null;
    } else {
      pythonCache = findPython310() || null;
    }
  } catch {
    pythonCache = null;
  }
  if (!pythonCache) console.warn("[HeadroomShim] no Python with headroom-ai found; compression will fail open");
  return pythonCache ?? null;
}

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase().replace(/^\[|\]$/g, ""));
}

function isCompressRequest(url: unknown, options: RequestInit | undefined): boolean {
  if (!url) return false;
  const method = String(options?.method || "GET").toUpperCase();
  if (method !== "POST") return false;
  let parsed: URL;
  try {
    const raw = typeof url === "string" ? url : url instanceof URL ? url : String(url);
    parsed = new URL(raw);
  } catch {
    return false;
  }
  // Exact path match only — the old proxy exposed exactly `/v1/compress`.
  if (parsed.pathname !== COMPRESS_SUFFIX) return false;
  // Only intercept loopback targets. An external (non-loopback) headroom URL
  // is presumably a live old-version proxy the operator configured on purpose.
  return isLoopbackHost(parsed.hostname);
}

function failOpenResponse(messages: unknown[]): Response {
  return new Response(
    JSON.stringify({ messages, tokens_before: 0, tokens_after: 0, tokens_saved: 0, compression_ratio: 0 }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// --- Persistent Python worker ---

type WorkerResult = {
  id?: number;
  ok: boolean;
  messages?: unknown[];
  tokens_before?: number;
  tokens_after?: number;
  tokens_saved?: number;
};

type PendingRequest = {
  resolve: (value: WorkerResult | null) => void;
  timer: NodeJS.Timeout;
};

type WorkerHandle = {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<boolean>;
};

let worker: WorkerHandle | null = null;
let workerPromise: Promise<WorkerHandle | null> | null = null;
let nextRequestId = 1;
let queueTail: Promise<unknown> = Promise.resolve();
const pending = new Map<number, PendingRequest>();
let stdoutBuffer = "";

function debugLog(...args: unknown[]): void {
  if (shimDebug()) console.log("[HeadroomShim][debug]", ...args);
}

function settlePending(reason: string): void {
  const count = pending.size;
  for (const { resolve, timer } of pending.values()) {
    clearTimeout(timer);
    resolve(null);
  }
  pending.clear();
  if (count > 0) debugLog(`settled ${count} pending requests (${reason})`);
}

function spawnWorker(py: string): WorkerHandle {
  let resolveReady: (v: boolean) => void = () => {};
  const ready = new Promise<boolean>((res) => {
    resolveReady = res;
  });
  const child = spawn(py, ["-u", "-c", PYTHON_WORKER], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
      HEADROOM_TELEMETRY: "off",
    },
  });
  child.unref();

  const handle: WorkerHandle = { child, ready };
  let resolvedReady = false;
  const markReady = (v: boolean) => {
    if (resolvedReady) return;
    resolvedReady = true;
    resolveReady(v);
  };

  child.stdout.on("data", (d: Buffer) => {
    stdoutBuffer += d.toString("utf8");
    let idx: number;
    while ((idx = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, idx).trim();
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      if (line === "READY") {
        markReady(true);
        continue;
      }
      let msg: WorkerResult;
      try {
        msg = JSON.parse(line);
      } catch {
        debugLog("non-JSON worker line:", line.slice(0, 200));
        continue;
      }
      const reqId = typeof msg?.id === "number" ? msg.id : null;
      if (reqId === null) continue;
      const req = pending.get(reqId);
      if (!req) continue;
      clearTimeout(req.timer);
      pending.delete(reqId);
      req.resolve(msg.ok ? msg : null);
    }
  });

  let stderrHead = "";
  child.stderr.on("data", (d: Buffer) => {
    const text = d.toString("utf8");
    if (!stderrHead) {
      const first = text.split("\n").map((l) => l.trim()).find(Boolean);
      if (first) stderrHead = first.slice(0, 200);
    }
    if (shimDebug()) console.warn("[HeadroomShim][worker] stderr:", text.slice(0, 500));
  });

  child.on("error", (e) => {
    debugLog("worker spawn failed:", e.message);
    markReady(false);
    if (worker === handle) worker = null;
    settlePending("worker spawn failed");
    console.warn(`[HeadroomShim] python worker spawn failed: ${e.message}`);
  });

  child.on("exit", (code, signal) => {
    debugLog(`worker exited code=${code} signal=${signal}`);
    markReady(false);
    if (worker === handle) worker = null;
    settlePending(`worker exited (code=${code})`);
    if (code !== 0) {
      console.warn(
        `[HeadroomShim] python worker exited code=${code}: ${stderrHead || "no stderr output"}. Next request will respawn. Run with HEADROOM_COMPRESS_SHIM_DEBUG=1 for full stderr.`
      );
    }
  });

  return handle;
}

function getWorker(): Promise<WorkerHandle | null> {
  if (worker) return Promise.resolve(worker);
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const py = await resolvePython();
    if (!py) return null;
    const handle = spawnWorker(py);
    worker = handle;
    return handle;
  })();
  workerPromise.finally(() => {
    workerPromise = null;
  });
  return workerPromise;
}

function killWorker(handle: WorkerHandle): void {
  if (worker === handle) worker = null;
  try {
    handle.child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  settlePending("worker killed");
}

/** Stop the Python worker (used on server shutdown; no-op if not running). */
export function stopCompressWorker(): void {
  if (worker) {
    debugLog("stopping worker on shutdown");
    killWorker(worker);
  }
}

async function compressViaPython(payload: {
  messages?: unknown[];
  model?: string;
  config?: unknown;
}): Promise<WorkerResult | null> {
  const run = async (): Promise<WorkerResult | null> => {
    const handle = await getWorker();
    if (!handle) return null;
    const id = nextRequestId++;
    const timeoutMs = shimTimeoutMs();
    // Start the per-request budget BEFORE awaiting worker readiness: a slow or
    // unhealthy worker (never emits READY) fails open within the same timeout
    // instead of hanging the request indefinitely.
    return new Promise<WorkerResult | null>((resolvePromise) => {
      let done = false;
      const finish = (value: WorkerResult | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pending.delete(id);
        resolvePromise(value);
      };
      const timer = setTimeout(() => {
        pending.delete(id);
        // A wedged worker will never answer; kill it so the next request respawns.
        killWorker(handle);
        finish(null);
      }, timeoutMs);
      pending.set(id, { resolve: finish, timer });
      void handle.ready.then((ready) => {
        if (!ready) {
          finish(null);
          return;
        }
        try {
          handle.child.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
        } catch {
          finish(null);
        }
      });
    });
  };
  // Serialize requests: the single worker handles one at a time.
  const result = queueTail.then(run, run);
  queueTail = result.catch(() => {});
  return result;
}

async function handleCompress(url: unknown, options: RequestInit | undefined): Promise<Response> {
  let bodyText = "";
  let messages: unknown[] | null = null;
  try {
    if (options?.body != null) {
      bodyText = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    }
    const parsed = JSON.parse(bodyText || "{}");
    messages = Array.isArray(parsed.messages) ? parsed.messages : null;
    if (!messages) {
      return failOpenResponse([]);
    }
    const result = await compressViaPython({ messages, model: parsed.model, config: parsed.config });
    if (result && Array.isArray(result.messages)) {
      return new Response(
        JSON.stringify({
          messages: result.messages,
          tokens_before: result.tokens_before || 0,
          tokens_after: result.tokens_after || 0,
          tokens_saved: result.tokens_saved || 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    console.warn("[HeadroomShim] compression unavailable; returning original messages (fail-open)");
    return failOpenResponse(messages);
  } catch {
    // Fail-open echoes the ORIGINAL messages (not an empty array) so the 9router
    // core continues with an unchanged request body on any unexpected error.
    return failOpenResponse(messages || []);
  }
}

// Prewarm only when headroom is enabled at a loopback URL; otherwise defer the
// worker to the first compress call so no Python process forks at boot when
// the shim would never be used (headroom disabled or an external proxy URL).
async function shouldPrewarm(): Promise<boolean> {
  try {
    const settings = (await getSettings()) as any;
    if (!settings?.headroomEnabled) {
      console.log("[HeadroomShim] headroom disabled in settings; python worker deferred to first compress call");
      return false;
    }
    const url = settings?.headroomUrl || DEFAULT_HEADROOM_URL;
    if (!isLoopbackHeadroomUrl(url)) {
      console.log("[HeadroomShim] non-loopback headroom URL configured; shim won't intercept, skipping prewarm");
      return false;
    }
    return true;
  } catch {
    // Settings unavailable (e.g. no DB yet) — defer to the first compress call.
    return false;
  }
}

/**
 * Install the global fetch interception for the removed `/v1/compress`
 * contract. Must be called after `open-sse/index.js` has installed its own
 * fetch patch (server.ts already imports it first).
 */
export function initHeadroomCompressShim(): void {
  if (!shimEnabled()) {
    console.log("[HeadroomShim] disabled via HEADROOM_COMPRESS_SHIM=off");
    return;
  }
  const baseFetch = globalThis.fetch.bind(globalThis);
  type FetchInput = Parameters<typeof fetch>[0];
  globalThis.fetch = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    if (isCompressRequest(input, init)) {
      return handleCompress(input, init);
    }
    return baseFetch(input, init);
  };
  // Prewarm: spawn the Python worker now so the one-time import cost is paid
  // before the first request arrives — but only when it will actually be used.
  // Never awaited — requests fail open if the worker is still importing and
  // something goes wrong.
  void shouldPrewarm().then((prewarm) => {
    if (!prewarm) return;
    void getWorker().then((h) => {
      if (h) console.log(`[HeadroomShim] python worker spawned (pid=${h.child.pid})`);
    });
  });
  console.log("[HeadroomShim] /v1/compress shim active (loopback targets, Python worker, fail-open)");
}

// Exposed for tests/validation scripts.
export const __test__ = { isCompressRequest, compressViaPython, stopCompressWorker };
