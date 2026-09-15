// ====================================================================
// WORKER V6 + UDP RELAY - PERFORMANCE MAXIMAL
// ====================================================================

const WORKER_URLS = [
  'cf.bebas11.workers.dev','cf.bebas9.workers.dev','avaritia.elvinrakus.workers.dev'
];

// ==================== KONFIGURASI ====================
const CACHE_KEY = 'worker_stats_v6';
const DEFAULT_SCORE = 100;
const MAX_CONSECUTIVE_FAILURES = 3;
const COOLDOWN_SECONDS = 60;
const MIN_TIMEOUT = 2000;
const MAX_TIMEOUT = 10000;
const INITIAL_BATCH_SIZE = 3;
const MAX_BATCH_SIZE = 6;

const EWMA_ALPHA = 0.3;
const SUCCESS_RATE_WINDOW = 20;
const PREDICTIVE_SCORE_WEIGHT = 0.4;
const JITTER_PENALTY_THRESHOLD = 500;
const BLACKLIST_SCORE_THRESHOLD = 20;
const BLACKLIST_DURATION = 120;
const RECOVERY_INTERVAL = 30;
const P95_PERCENTILE = 0.95;
const LATENCY_HISTORY_SIZE = 30;

// ==================== UDP RELAY CONFIG ====================
// HARUS domain PUBLIK Railway (bukan *.railway.internal)
const UDP_RELAY_URL    = 'wsudprelay-production-7524.up.railway.app';
const UDP_RELAY_PATH   = '/udp';
const UDP_RELAY_SECRET = ''; // isi kalau relay pakai auth

// ==================== EXPORT FETCH ====================
export default {
  async fetch(request, env, ctx) {
    const parsedUrl = new URL(request.url);

    // ========== UDP RELAY HANDLER ==========
    if (parsedUrl.pathname === UDP_RELAY_PATH) {
      return handleUdpRelay(request, env, ctx);
    }

    const startTime = performance.now();
    const cache = caches.default;

    let workerStats = await getWorkerStats(cache);
    if (!workerStats) {
      workerStats = initializeStats(WORKER_URLS);
    }

    const now = Date.now();
    const available = workerStats.filter(s =>
      s.cooldownUntil <= now && !s.blacklisted
    );
    if (available.length === 0) {
      return new Response('Semua worker sedang cooldown/blacklist. Coba lagi nanti.', { status: 503 });
    }

    // ========== 1. SMART RANKING ==========
    available.forEach(worker => {
      const latencyScore = worker.ewmaLatency > 0
        ? Math.max(0, 100 - (worker.ewmaLatency / 50))
        : 50;

      const successRate = worker.successRate || 0.5;
      const successScore = successRate * 100;

      const predictive = (latencyScore * 0.6 + successScore * 0.4) * (1 - PREDICTIVE_SCORE_WEIGHT)
                       + (worker.predictiveScore || 50) * PREDICTIVE_SCORE_WEIGHT;

      const jitterPenalty = (worker.jitter > JITTER_PENALTY_THRESHOLD)
        ? Math.min(30, (worker.jitter - JITTER_PENALTY_THRESHOLD) / 50)
        : 0;

      let finalScore = Math.min(100, Math.max(0, predictive - jitterPenalty));

      if (worker.recoveryUntil && worker.recoveryUntil > now) {
        finalScore = Math.min(100, finalScore + 10);
      }

      worker.score = finalScore;
      worker.predictiveScore = predictive;
    });

    // ========== 2. TOP-N ==========
    const sorted = [...available].sort((a, b) => b.score - a.score);
    const topWorkers = sorted.slice(0, Math.min(MAX_BATCH_SIZE, sorted.length));

    let avgLatency = 3000;
    const latencies = topWorkers.map(w => w.ewmaLatency).filter(l => l > 0);
    if (latencies.length > 0) {
      avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    }

    // ========== 3. ADAPTIVE PARALLEL ==========
    let batchSize = INITIAL_BATCH_SIZE;
    if (topWorkers.length > 10 && avgLatency < 2000) {
      batchSize = Math.min(MAX_BATCH_SIZE, Math.floor(topWorkers.length / 2));
    } else if (topWorkers.length > 5) {
      batchSize = INITIAL_BATCH_SIZE;
    } else {
      batchSize = Math.min(INITIAL_BATCH_SIZE, topWorkers.length);
    }
    batchSize = Math.max(1, batchSize);

    // ========== 4. INTELLIGENT TIMEOUT (P95) ==========
    const allLatencies = [];
    topWorkers.forEach(w => {
      if (w.latencyHistory && w.latencyHistory.length > 0) {
        allLatencies.push(...w.latencyHistory);
      }
    });
    let p95 = avgLatency * 1.5 + 1000;
    if (allLatencies.length > 10) {
      const sortedLat = [...allLatencies].sort((a, b) => a - b);
      const idx = Math.floor(sortedLat.length * P95_PERCENTILE);
      p95 = sortedLat[Math.min(idx, sortedLat.length - 1)];
    }
    let timeout = Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, p95 + 500));
    timeout = Math.round(timeout);

    const urlPathAndQuery = parsedUrl.pathname + parsedUrl.search;
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const modifiedHeaders = new Headers(request.headers);
    modifiedHeaders.set('Connection', 'keep-alive');
    if (!modifiedHeaders.has('Accept-Encoding')) {
      modifiedHeaders.set('Accept-Encoding', 'gzip, deflate, br');
    }

    // ---- Loop batch ----
    for (let i = 0; i < topWorkers.length; i += batchSize) {
      const batch = topWorkers.slice(i, i + batchSize);

      const promises = batch.map(async (worker) => {
        const url = worker.url;
        try {
          const targetUrl = `https://${url}${urlPathAndQuery}`;
          const reqClone = hasBody ? request.clone() : request;
          const modifiedRequest = new Request(targetUrl, {
            method: request.method,
            headers: modifiedHeaders,
            body: hasBody ? reqClone.body : null,
            redirect: 'manual'
          });

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          const response = await fetch(modifiedRequest, { signal: controller.signal });
          clearTimeout(timer);

          if (response.status === 429 || response.status >= 500) {
            throw new Error(`Status ${response.status}`);
          }

          const latency = performance.now() - startTime;
          updateWorkerStats(worker, true, latency, response.status);
          return response;
        } catch (err) {
          updateWorkerStats(worker, false, 0, 0);
          throw err;
        }
      });

      try {
        const response = await Promise.any(promises);
        ctx.waitUntil(performPassiveHealthCheck(workerStats, cache, ctx));
        ctx.waitUntil(saveWorkerStats(cache, workerStats));
        return response;
      } catch (err) {
        continue;
      }
    }

    ctx.waitUntil(saveWorkerStats(cache, workerStats));
    return new Response('Semua worker gagal. Coba lagi nanti.', { status: 503 });
  }
};

// ==================== UDP RELAY HANDLER ====================
async function handleUdpRelay(request, env, ctx) {
  const upgrade = request.headers.get('Upgrade');
  if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  if (UDP_RELAY_SECRET) {
    const token = request.headers.get('X-Relay-Secret') || '';
    if (token !== UDP_RELAY_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get('target') || '1.1.1.1:53';

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  let relayWs;
  try {
    const relayUrl = new URL(UDP_RELAY_URL);
    relayUrl.searchParams.set('target', target);

    const relayResp = await fetch(relayUrl.toString(), {
      headers: {
        'Upgrade': 'websocket',
        'X-Relay-Secret': UDP_RELAY_SECRET,
        'X-Udp-Target': target
      }
    });

    relayWs = relayResp.webSocket;
    if (!relayWs) throw new Error('Relay tidak mengembalikan WebSocket');
    relayWs.accept();
  } catch (err) {
    try { server.close(1011, 'Relay unavailable: ' + err.message); } catch (_) {}
    return new Response(null, { status: 101, webSocket: client });
  }

  server.addEventListener('message', (ev) => {
    try { relayWs.send(ev.data); }
    catch (_) { try { server.close(1011, 'relay send fail'); } catch (_) {} }
  });
  server.addEventListener('close', () => { try { relayWs.close(); } catch (_) {} });
  server.addEventListener('error', () => { try { relayWs.close(); } catch (_) {} });

  relayWs.addEventListener('message', (ev) => {
    try { server.send(ev.data); }
    catch (_) { try { relayWs.close(1011, 'client send fail'); } catch (_) {} }
  });
  relayWs.addEventListener('close', () => { try { server.close(); } catch (_) {} });
  relayWs.addEventListener('error', () => { try { server.close(); } catch (_) {} });

  return new Response(null, { status: 101, webSocket: client });
}

// ==================== HELPER ====================
async function getWorkerStats(cache) {
  try {
    const cacheKey = new Request(CACHE_KEY);
    const cached = await cache.match(cacheKey);
    if (cached) return await cached.json();
  } catch (_) {}
  return null;
}

async function saveWorkerStats(cache, stats) {
  try {
    const json = JSON.stringify(stats);
    const response = new Response(json, {
      headers: { 'Content-Type': 'application/json' }
    });
    const cacheKey = new Request(CACHE_KEY);
    await cache.put(cacheKey, response);
  } catch (_) {}
}

function initializeStats(urls) {
  return urls.map(url => ({
    url,
    score: DEFAULT_SCORE,
    consecutiveFailures: 0,
    cooldownUntil: 0,
    ewmaLatency: 0,
    successRate: 1.0,
    totalRequests: 0,
    successCount: 0,
    lastUpdated: Date.now(),
    predictiveScore: 50,
    jitter: 0,
    latencyHistory: [],
    blacklisted: false,
    blacklistUntil: 0,
    recoveryUntil: 0,
  }));
}

function updateWorkerStats(worker, success, latency, status) {
  const now = Date.now();
  worker.totalRequests++;

  if (success) worker.successCount++;
  const total = worker.totalRequests;
  const successes = worker.successCount;
  const currentRate = successes / total;
  worker.successRate = worker.successRate * 0.9 + currentRate * 0.1;

  if (success) {
    if (worker.ewmaLatency === 0) {
      worker.ewmaLatency = latency;
    } else {
      worker.ewmaLatency = worker.ewmaLatency * (1 - EWMA_ALPHA) + latency * EWMA_ALPHA;
    }

    if (!worker.latencyHistory) worker.latencyHistory = [];
    worker.latencyHistory.push(latency);
    if (worker.latencyHistory.length > LATENCY_HISTORY_SIZE) {
      worker.latencyHistory.shift();
    }

    if (worker.latencyHistory.length > 2) {
      const avg = worker.latencyHistory.reduce((a, b) => a + b, 0) / worker.latencyHistory.length;
      const variance = worker.latencyHistory.reduce((a, b) => a + (b - avg) ** 2, 0) / worker.latencyHistory.length;
      worker.jitter = Math.sqrt(variance);
    } else {
      worker.jitter = 0;
    }

    worker.consecutiveFailures = 0;
    worker.cooldownUntil = 0;
    if (worker.blacklisted) {
      worker.blacklisted = false;
      worker.blacklistUntil = 0;
      worker.recoveryUntil = now + RECOVERY_INTERVAL * 1000;
    }

    if (worker.recoveryUntil > now) {
      worker.score = Math.min(100, worker.score + 2);
    } else {
      worker.recoveryUntil = 0;
    }

    const latencyScore = worker.ewmaLatency > 0
      ? Math.max(0, 100 - (worker.ewmaLatency / 50))
      : 50;
    const successScore = worker.successRate * 100;
    worker.predictiveScore = latencyScore * 0.6 + successScore * 0.4;
  } else {
    worker.consecutiveFailures++;
    worker.score = Math.max(0, worker.score - 10);

    if (worker.score < BLACKLIST_SCORE_THRESHOLD || worker.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      worker.blacklisted = true;
      worker.blacklistUntil = now + BLACKLIST_DURATION * 1000;
      worker.cooldownUntil = worker.blacklistUntil;
      worker.score = Math.min(worker.score, BLACKLIST_SCORE_THRESHOLD - 1);
    } else {
      if (worker.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        worker.cooldownUntil = now + COOLDOWN_SECONDS * 1000;
      }
    }
  }

  worker.lastUpdated = now;
}

async function performPassiveHealthCheck(workerStats, cache, ctx) {
  const now = Date.now();
  const candidates = workerStats.filter(w =>
    w.cooldownUntil > now || w.blacklisted || w.score < 40
  );
  if (candidates.length === 0) return;

  const toCheck = candidates.slice(0, 3);
  const checkPromises = toCheck.map(async (worker) => {
    try {
      const url = `https://${worker.url}/`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const resp = await fetch(url, { method: 'HEAD', signal: controller.signal });
      clearTimeout(timer);
      if (resp.ok) {
        worker.consecutiveFailures = 0;
        worker.cooldownUntil = 0;
        if (worker.blacklisted && worker.blacklistUntil < now + 10000) {
          worker.blacklisted = false;
          worker.blacklistUntil = 0;
          worker.recoveryUntil = now + RECOVERY_INTERVAL * 1000;
        }
        worker.score = Math.min(100, worker.score + 5);
      }
    } catch (_) {}
  });

  await Promise.allSettled(checkPromises);
  await saveWorkerStats(cache, workerStats);
}
