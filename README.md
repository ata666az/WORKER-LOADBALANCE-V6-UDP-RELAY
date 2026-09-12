# CF Worker V6 + UDP Relay 🚀

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

Cloudflare Worker performa tinggi dengan **Smart Load Balancing** ke ratusan endpoint worker, plus **UDP Relay tunnel** via WebSocket ke server Railway.

> **TL;DR** — Worker ini menerima request HTTP → memilih endpoint terbaik secara dinamis (EWMA latency, success rate, jitter, P95 timeout) → meneruskan request paralel ke beberapa worker teratas dengan strategi *hedging*. Selain itu, tersedia endpoint `/udp` untuk tunnel UDP melalui WebSocket.

> 📦 **Relay server Railway** (yang menerjemahkan WebSocket → UDP) tersedia di repo terpisah:  
> 👉 **[github.com/ata666az/Relay-Railway](https://github.com/ata666az/Relay-Railway)**

---

## 📑 Daftar Isi

- [Fitur Utama](#-fitur-utama)
- [Arsitektur](#-arsitektur)
- [Cara Deploy](#-cara-deploy)
- [Konfigurasi](#-konfigurasi)
- [Cara Pakai](#-cara-pakai)
- [Troubleshooting](#-troubleshooting)
- [Batasan & Catatan Penting](#️-batasan--catatan-penting)
- [Struktur File](#️-struktur-file)
- [Development Lokal](#️-development-lokal)
- [Monitoring](#-monitoring)
- [Kontribusi](#-kontribusi)
- [Lisensi](#-lisensi)

---

## ✨ Fitur Utama

### 🎯 Smart Load Balancing (HTTP Proxy)

| Fitur | Deskripsi |
|---|---|
| **EWMA Latency** | Estimasi latency bergerak — worker lambat otomatis turun peringkat |
| **Success Rate Tracking** | Persentase keberhasilan per worker dihitung real-time |
| **Jitter Detection** | Variasi latency tinggi = penalti skor (indikasi worker tidak stabil) |
| **Predictive Scoring** | Skor masa depan diperkirakan dari kombinasi latency + success rate |
| **Weighted Top-N Selection** | Hanya N worker teratas yang dipakai per request |
| **Adaptive Parallel Requests** | Jumlah request paralel menyesuaikan kondisi jaringan |
| **Intelligent Timeout (P95)** | Timeout dihitung dari persentil-95 latency historis |
| **Auto Blacklist + Recovery** | Worker bermasalah di-blacklist sementara, dipulihkan otomatis |
| **Passive Health Check** | Worker yang cooldown dicek di background (HEAD request) |
| **Persistent Stats via Cache API** | Statistik bertahan antar request tanpa database |

### 🌐 UDP Relay (WebSocket Tunnel)

| Fitur | Deskripsi |
|---|---|
| **WebSocket ⇄ UDP Bridge** | Client WebSocket → Worker → Railway → UDP socket |
| **Auth via Header** | Opsional `X-Relay-Secret` untuk mencegah abuse |
| **Dynamic Target** | Kirim ke UDP host:port manapun via query `?target=1.1.1.1:53` |
| **IPv4 & IPv6** | Auto-detect family berdasarkan host |
| **Idle Timeout** | Koneksi nganggur >2 menit ditutup otomatis |

> 💡 **Butuh server relay-nya?** Kode lengkap server Railway (Node.js + `ws` + `dgram`) ada di:  
> 🔗 **[https://github.com/ata666az/Relay-Railway](https://github.com/ata666az/Relay-Railway)**

---

## 📦 Arsitektur

```
┌──────────┐    HTTPS     ┌─────────────────┐   HTTPS (parallel)   ┌──────────────────┐
│  Client  │ ───────────► │ Cloudflare      │ ───────────────────► │  Worker Pool     │
│          │              │ Worker (V6)     │   (top-N, hedging)   │  (200+ endpoint) │
└──────────┘              │                 │                      └──────────────────┘
                          │                 │
                          │  WebSocket      │   WSS                ┌──────────────────┐
┌──────────┐   WSS        │  /udp handler   │ ───────────────────► │ Railway UDP      │
│  Client  │ ───────────► │  (tunnel)       │   (?target=...)      │ Relay            │
│  (UDP)   │              │                 │                      │  ⇄ UDP socket    │
└──────────┘              └─────────────────┘                      └──────────────────┘
                                                                        ▲
                                                                        │
                                                    Repo terpisah:      │
                                        github.com/ata666az/Relay-Railway
```

**Alur Load Balancing:**

1. Client kirim request ke Worker
2. Worker load stats dari Cache API (per-datacenter)
3. Filter worker yang tidak cooldown/blacklist
4. Hitung skor setiap worker (latency + success + jitter + prediction)
5. Ambil N worker teratas
6. Kirim request paralel ke batch worker → ambil yang **paling cepat** (`Promise.any`)
7. Update stats (EWMA, success rate, jitter)
8. Background: passive health check untuk worker cooldown

---

## 🚀 Cara Deploy

### 1. Clone Repo Ini

```bash
git clone https://github.com/ata666az/WORKER-LOADBALANCE-V6-UDP-RELAY.git
cd WORKER-LOADBALANCE-V6-UDP-RELAY
```

### 2. Deploy ke Cloudflare Workers

#### Cara A — Via Dashboard (paling cepat)

1. Buka [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Worker**
2. Klik **Edit Code**, hapus default, tempel isi `worker.js`
3. Klik **Save and Deploy**
4. Copy URL worker Anda, misal: `https://[GANTI: NAMA-WORKER].workers.dev`

#### Cara B — Via Wrangler CLI

```bash
npm install -g wrangler
wrangler login
wrangler deploy worker.js --name [GANTI: NAMA-WORKER]
```

### 3. Setup UDP Relay di Railway

UDP relay butuh server terpisah di Railway karena Cloudflare Workers **tidak bisa** raw UDP socket.

> 📖 **Panduan lengkap ada di repo terpisah:**
> 👉 **[https://github.com/ata666az/Relay-Railway](https://github.com/ata666az/Relay-Railway)**
>
> Repo tersebut berisi:
> - `server.js` — Server WebSocket ⇄ UDP bridge
> - `package.json` — Dependency (`ws`)
> - `railway.json` — Konfigurasi deploy Railway
> - `README.md` — Panduan deploy step-by-step

**Ringkasan langkah:**

1. Clone repo relay: `git clone https://github.com/ata666az/Relay-Railway.git`
2. Deploy ke Railway via GitHub integration
3. Generate domain publik di Railway: **Settings** → **Networking** → **Generate Domain**
4. Set environment variable `RELAY_SECRET` (opsional, untuk auth)

Setelah relay deploy, update di `worker.js`:

```js
const UDP_RELAY_URL    = 'wss://[GANTI: DOMAIN-RAILWAY].up.railway.app/udp';
const UDP_RELAY_SECRET = ''; // isi token rahasia kalau pakai auth
```

Deploy ulang worker.

---

## 🔧 Konfigurasi

Semua konfigurasi ada di bagian atas `worker.js`.

### Load Balancing

```js
const DEFAULT_SCORE            = 100;    // skor awal setiap worker
const MAX_CONSECUTIVE_FAILURES = 3;      // gagal berapa kali sebelum cooldown
const COOLDOWN_SECONDS         = 60;     // durasi cooldown (detik)
const MIN_TIMEOUT              = 2000;   // timeout minimum (ms)
const MAX_TIMEOUT              = 10000;  // timeout maksimum (ms)
const INITIAL_BATCH_SIZE       = 3;      // jumlah request paralel awal
const MAX_BATCH_SIZE           = 6;      // jumlah request paralel maksimum

const EWMA_ALPHA               = 0.3;    // faktor peluruhan EWMA (0-1)
const PREDICTIVE_SCORE_WEIGHT  = 0.4;    // bobot prediksi dalam skor akhir
const JITTER_PENALTY_THRESHOLD = 500;    // ms, jitter di atas ini = penalti
const BLACKLIST_SCORE_THRESHOLD = 20;    // skor < ini = blacklist
const BLACKLIST_DURATION       = 120;    // durasi blacklist (detik)
const RECOVERY_INTERVAL        = 30;     // detik, pemulihan skor bertahap
const P95_PERCENTILE           = 0.95;   // untuk intelligent timeout
const LATENCY_HISTORY_SIZE     = 30;     // jumlah sampel untuk P95 & jitter
```

### UDP Relay

```js
const UDP_RELAY_URL    = 'wss://[GANTI: DOMAIN-RAILWAY].up.railway.app/udp';
const UDP_RELAY_PATH   = '/udp';
const UDP_RELAY_SECRET = ''; // kosongkan untuk tanpa auth
```

> 💡 Nilai `UDP_RELAY_URL` harus cocok dengan domain publik server relay di repo **[Relay-Railway](https://github.com/ata666az/Relay-Railway)**.

### Menambah Worker Endpoint

Cukup tambahkan URL ke array `WORKER_URLS`:

```js
const WORKER_URLS = [
  'cf.bebas11.workers.dev',
  'worker-baru.workers.dev',   // ← tambahkan di sini
  // ...
];
```

---

## 📡 Cara Pakai

### 1. HTTP Proxy

Cukup arahkan request ke worker Anda — otomatis diproxy:

```bash
curl https://[GANTI: NAMA-WORKER].workers.dev/api/endpoint
```

Request akan di-forward ke salah satu worker dari `WORKER_URLS` yang skornya tertinggi. Tidak perlu konfigurasi tambahan.

### 2. UDP Relay

#### Dari Browser (JavaScript)

```js
// DNS-over-UDP query untuk example.com
const dnsQuery = new Uint8Array([
  0xAB,0xCD, 0x01,0x00, 0x00,0x01, 0x00,0x00, 0x00,0x00, 0x00,0x00,
  0x07,0x65,0x78,0x61,0x6d,0x70,0x6c,0x65, 0x03,0x63,0x6f,0x6d, 0x00,
  0x00,0x01, 0x00,0x01
]);

const ws = new WebSocket(
  'wss://[GANTI: NAMA-WORKER].workers.dev/udp?target=1.1.1.1:53'
);
ws.binaryType = 'arraybuffer';

ws.onopen  = () => ws.send(dnsQuery);
ws.onmessage = (e) => {
  console.log('Respons:', new Uint8Array(e.data));
  ws.close();
};
ws.onerror = (e) => console.error('Error:', e);
```

#### Dari Node.js

```js
import WebSocket from 'ws';

const ws = new WebSocket(
  'wss://[GANTI: NAMA-WORKER].workers.dev/udp?target=1.1.1.1:53',
  { headers: { 'X-Relay-Secret': 'TOKEN_ANDA' } } // jika pakai auth
);
ws.binaryType = 'arraybuffer';

ws.on('open',  () => ws.send(dnsQuery));
ws.on('message', (data) => {
  console.log('Respons:', new Uint8Array(data));
  ws.close();
});
```

#### Dari CLI (`wscat`)

```bash
# Install
npm install -g wscat

# Tanpa auth
wscat -c "wss://[GANTI: NAMA-WORKER].workers.dev/udp?target=1.1.1.1:53"

# Dengan auth
wscat -c "wss://[GANTI: NAMA-WORKER].workers.dev/udp?target=1.1.1.1:53" \
      -H "X-Relay-Secret: TOKEN_ANDA"
```

---

## 🔍 Troubleshooting

| Gejala | Penyebab & Solusi |
|---|---|
| **401 Unauthorized** saat akses `/udp` | `UDP_RELAY_SECRET` di worker tidak kosong tapi client tidak kirim header `X-Relay-Secret`. Kirim header, atau kosongkan secret. |
| **426 Upgrade Required** | Akses `/udp` via HTTP biasa. Harus WebSocket. |
| **1011 Relay unavailable** | Worker gagal konek ke Railway. Cek `UDP_RELAY_URL` benar & relay hidup. Pastikan relay dari repo [Relay-Railway](https://github.com/ata666az/Relay-Railway) sudah dideploy. |
| **1008 Unauthorized (dari Railway)** | `RELAY_SECRET` di Railway ≠ `X-Relay-Secret` yang dikirim Worker. |
| **502/503 dari proxy** | Semua worker sedang cooldown. Tunggu ±60 detik atau tambahkan endpoint baru. |
| **Response lambat** | Kemungkinan banyak worker down. Cek statistik & kurangi endpoint mati. |
| **Twilio TURN test gagal** | **Normal!** Twilio TURN test menguji UDP langsung browser→server TURN, bukan lewat WebSocket proxy. Ini bukan indikasi relay rusak. |
| **Syntax error saat deploy** | Pastikan file `worker.js` lengkap (≥700 baris). File yang terpotong akan gagal parse. |

### Cara Cek Relay Hidup

```bash
# 1. Cek health relay Railway
curl https://[GANTI: DOMAIN-RAILWAY].up.railway.app/health
# Harus return JSON: {"status":"ok", ...}

# 2. Cek WebSocket handshake
wscat -c "wss://[GANTI: NAMA-WORKER].workers.dev/udp?target=1.1.1.1:53"
# Harus muncul: Connected (press CTRL+C to quit)

# 3. Tes end-to-end kirim DNS query
# Lihat bagian "Cara Pakai → UDP Relay → Dari Browser"
```

> 🛠️ **Relay server bermasalah?** Buka issue di repo relay:  
> 👉 **[github.com/ata666az/Relay-Railway/issues](https://github.com/ata666az/Relay-Railway/issues)**

### Cek via DevTools Console

```js
// Paste di browser Console (F12)
const ws = new WebSocket('wss://[GANTI: NAMA-WORKER].workers.dev/udp?target=1.1.1.1:53');
ws.onopen  = () => console.log('✅ WebSocket OPEN');
ws.onerror = (e) => console.error('❌ ERROR', e);
ws.onclose = (e) => console.log('🔒 CLOSED code=' + e.code, e.reason);
setTimeout(() => ws.close(), 3000);
```

| Log | Artinya |
|---|---|
| `✅ WebSocket OPEN` | Relay & handshake OK |
| `❌ ERROR` + `code=1006` | Relay tidak bisa dijangkau |
| `🔒 CLOSED code=1008` | Auth gagal |
| `🔒 CLOSED code=1013` | Server sibuk (max connection) |

---

## ⚠️ Batasan & Catatan Penting

1. **Cloudflare Workers tidak bisa raw UDP socket.** Relay UDP harus melalui WebSocket + server perantara (Railway). Kode relay: **[Relay-Railway](https://github.com/ata666az/Relay-Railway)**.
2. **`*.railway.internal` tidak bisa diakses dari Cloudflare.** Gunakan domain publik yang di-generate Railway (Settings → Networking → Generate Domain).
3. **Twilio TURN Connectivity Test** tidak akan pernah sukses lewat proxy WebSocket — tes ini menguji jalur UDP langsung dari browser ke server TURN Twilio.
4. **Cache API bersifat per-datacenter.** Statistik worker tidak sinkron antar region Cloudflare. Setiap PoP punya stats sendiri.
5. **Jangan taruh token rahasia di repo publik.** Gunakan environment variable (`env.UDP_RELAY_SECRET`) atau `.dev.vars` untuk development lokal.
6. **Rate limit Cloudflare Workers:** 100.000 request/hari (free tier). Untuk trafik tinggi, upgrade ke paid plan.
7. **UDP relay bersifat best-effort.** Paket UDP bisa hilang — ini karakteristik protokol UDP, bukan bug.
8. **Latency tambahan.** Setiap paket UDP melewati 2 hop (Worker → Railway → UDP), jadi ada tambahan ~50-150ms dibanding UDP langsung.

---

## 🗂️ Struktur File

```
.
├── worker.js        # Cloudflare Worker utama (load balancer + UDP relay)
├── README.md        # Dokumen ini
├── .gitignore       # File yang tidak di-commit
└── .dev.vars        # (opsional) environment untuk dev lokal — JANGAN commit
```

> **Relay server Railway** disimpan di repo terpisah:  
> 👉 **[https://github.com/ata666az/Relay-Railway](https://github.com/ata666az/Relay-Railway)**
>
> Repo tersebut berisi:
> ```
> Relay-Railway/
> ├── server.js       # WebSocket ⇄ UDP bridge (Node.js + ws + dgram)
> ├── package.json    # Dependency
> ├── railway.json    # Konfigurasi deploy Railway
> ├── .env.example    # Contoh environment variable
> └── README.md       # Panduan deploy relay
> ```

### `.gitignore` yang disarankan

```
node_modules/
.wrangler/
.dev.vars
.env
*.log
.DS_Store
.idea/
.vscode/
```

### `.dev.vars` untuk development lokal

```
UDP_RELAY_SECRET=tokenrahasia123
```

---

## 🛠️ Development Lokal

```bash
# Install wrangler
npm install -g wrangler

# Jalankan dev server (hot reload)
wrangler dev worker.js

# Server jalan di http://localhost:8787

# Test HTTP proxy
curl http://localhost:8787/

# Test UDP relay
wscat -c "ws://localhost:8787/udp?target=1.1.1.1:53"
```

### Menjalankan Relay Railway Secara Lokal (untuk development)

Kalau Anda ingin test relay di lokal sebelum deploy:

```bash
# Clone repo relay
git clone https://github.com/ata666az/Relay-Railway.git
cd Relay-Railway

# Install dependency
npm install

# Jalankan
npm start
# Server jalan di http://localhost:8080
```

Lalu di `worker.js` (khusus dev), ganti:

```js
const UDP_RELAY_URL = 'ws://localhost:8080/udp';
```

---

## 📊 Monitoring

### Statistik via Endpoint Debug (opsional)

Tambahkan handler ini di `worker.js` di dalam `fetch` (setelah baris `const parsedUrl = new URL(request.url);`):

```js
if (parsedUrl.pathname === '/_stats') {
  const cache = caches.default;
  const stats = await getWorkerStats(cache) || [];
  const summary = stats
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(w => ({
      url: w.url,
      score: Number(w.score.toFixed(1)),
      latency: Number(w.ewmaLatency.toFixed(0)),
      success: Number((w.successRate * 100).toFixed(1)),
      jitter: Number(w.jitter.toFixed(0)),
      blacklisted: w.blacklisted,
      cooldown_until: w.cooldownUntil
    }));
  return Response.json(summary, {
    headers: { 'Access-Control-Allow-Origin': '*' }
  });
}
```

Akses: `https://[GANTI: NAMA-WORKER].workers.dev/_stats`

Contoh output:

```json
[
  {
    "url": "cf.bebas11.workers.dev",
    "score": 98.5,
    "latency": 120,
    "success": 99.8,
    "jitter": 45,
    "blacklisted": false,
    "cooldown_until": 0
  },
  {
    "url": "worker-lambat.workers.dev",
    "score": 45.2,
    "latency": 3200,
    "success": 82.1,
    "jitter": 980,
    "blacklisted": true,
    "cooldown_until": 1736784000000
  }
]
```

### Live Logs

```bash
# Stream logs dari Cloudflare
wrangler tail [GANTI: NAMA-WORKER]

# Logs Railway (untuk relay) — buka dashboard Railway:
# Service relay → Deployments → klik deployment → "View Logs"
```

---

## 🤝 Kontribusi

Pull request diterima! Untuk perubahan besar, buka issue dulu untuk diskusi.

1. Fork repo
2. Buat branch fitur (`git checkout -b fitur/awesome`)
3. Commit (`git commit -m 'Add awesome feature'`)
4. Push (`git push origin fitur/awesome`)
5. Buka Pull Request

### Panduan Coding

- Gunakan JavaScript modern (ES2022+)
- Jangan tambahkan dependency eksternal — Workers runtime terbatas
- Test di `wrangler dev` sebelum push
- Update README jika menambah fitur/konfigurasi baru

### 🐛 Untuk masalah pada relay Railway

Buka issue di repo relay langsung:  
👉 **[github.com/ata666az/Relay-Railway/issues](https://github.com/ata666az/Relay-Railway/issues)**

---

## 📜 Lisensi

MIT License

```
Copyright (c) 2026 @XairenXue(ATA)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## ⚡ Credits

- Dibuat dengan ❤️ untuk komunitas Cloudflare Workers Indonesia
- Powered by [Cloudflare Workers](https://workers.cloudflare.com/) + [Railway](https://railway.app/)

---

<p align="center">⭐ Jika repo ini bermanfaat, jangan lupa kasih bintang! ⭐</p>
