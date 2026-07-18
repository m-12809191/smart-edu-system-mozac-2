import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { get } from '@vercel/edge-config';
import dotenv from 'dotenv';
import fs from 'fs';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';

// Load environment variables
const secretsPath = path.resolve(process.cwd(), 'secrets.env');
if (fs.existsSync(secretsPath)) {
  console.log('[Env] Loading secrets from secrets.env (with override)');
  dotenv.config({ path: secretsPath, override: true });
} else {
  dotenv.config();
}

// --- Cloudflare R2 Configuration ---
let r2: S3Client | null = null;
const R2_BUCKET = process.env.R2_BUCKET_NAME;

try {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_ENDPOINT;

  if (accountId && accessKeyId && secretAccessKey && R2_BUCKET) {
    r2 = new S3Client({
      region: 'auto',
      endpoint: endpoint || `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
    console.log('[R2] Client initialized.');
  } else {
    console.warn('[R2] Missing configuration variables.');
  }
} catch (e) {
  console.error('[R2] Init error:', e);
}

// --- Unified Persistence Helpers ---
let reports: any[] = [];
let isCctvActive = false;
let systemLogs: { timestamp: number; level: 'info' | 'error' | 'warn'; message: string; source: string }[] = [];
let authorizedUsers: { id: string; role: 'student' | 'warden' | 'superadmin'; password?: string; name?: string }[] = [
  { id: 'S2024-001', role: 'student' },
  { id: 'S2024-002', role: 'student' },
  { id: 'S2024-003', role: 'student' },
  { id: 'BIO-STUDENT-01', role: 'student' },
  { id: 'warden@asrama.edu', role: 'warden', password: 'admin123' },
  { id: 'admin@edusafe.dpdns.org', role: 'superadmin', password: 'admin@2141', name: 'Super Admin' }
];

async function ensureSuperAdmin() {
  const superAdmin = authorizedUsers.find(u => u.role === 'superadmin');
  if (superAdmin && r2) {
    try {
      // Check if super admin exists in R2
      await r2.send(new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: `users/${superAdmin.id}.json`
      }));
    } catch (e) {
      // If not found, persist it
      console.log('[System] Persisting default superadmin to R2');
      await persistUser(superAdmin);
    }
  }
}
let featureFlags = {
  hybridSync: true,
  cctvFailover: true,
  pushNotifications: false,
  aiSentiment: false
};

function addLog(level: 'info' | 'error' | 'warn', message: string, source: string) {
  systemLogs.unshift({ timestamp: Date.now(), level, message, source });
  if (systemLogs.length > 50) systemLogs.pop();
  console[level](`[${source}] ${message}`);
}

async function loadInitialState() {
  addLog('info', 'Starting initial state load...', 'Storage');
  
  if (!r2) {
    addLog('warn', 'R2 not initialized. Using default state.', 'Storage');
    return;
  }

  try {
    // Load config
    try {
      const configRes = await r2.send(new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: 'config/system.json'
      }));
      const configStr = await configRes.Body?.transformToString();
      if (configStr) {
        const data = JSON.parse(configStr);
        if (data.featureFlags) featureFlags = { ...featureFlags, ...data.featureFlags };
        if (data.isCctvActive !== undefined) isCctvActive = data.isCctvActive;
      }
    } catch (e) {
      addLog('info', 'No system config found in R2. Using defaults.', 'R2');
    }

    // Load users
    try {
      const usersList = await r2.send(new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: 'users/'
      }));
      if (usersList.Contents) {
        const userPromises = usersList.Contents.map(async (obj) => {
          const res = await r2?.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: obj.Key }));
          const str = await res?.Body?.transformToString();
          return str ? JSON.parse(str) : null;
        });
        const loadedUsers = (await Promise.all(userPromises)).filter(u => u !== null);
        if (loadedUsers.length > 0) {
          // Merge loaded users with hardcoded ones to ensure superadmin isn't lost
          const userMap = new Map();
          authorizedUsers.forEach(u => userMap.set(u.id, u));
          loadedUsers.forEach(u => userMap.set(u.id, u));
          authorizedUsers = Array.from(userMap.values());
        }
      }
    } catch (e) {
      addLog('info', 'No users found in R2 or list failed.', 'R2');
    }

    // Load reports
    try {
      const reportsList = await r2.send(new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: 'reports/'
      }));
      if (reportsList.Contents) {
        const reportPromises = reportsList.Contents.map(async (obj) => {
          const res = await r2?.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: obj.Key }));
          const str = await res?.Body?.transformToString();
          return str ? JSON.parse(str) : null;
        });
        const loadedReports = (await Promise.all(reportPromises)).filter(r => r !== null);
        reports = loadedReports.sort((a, b) => b.timestamp - a.timestamp);
      }
    } catch (e) {
      addLog('info', 'No reports found in R2 or list failed.', 'R2');
    }

    addLog('info', 'Successfully loaded state from R2.', 'R2');
  } catch (err: any) {
    addLog('error', `R2 Load error: ${err.message}`, 'R2');
  }
}

async function sendTelegramNotification(report: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    addLog('warn', 'Telegram Bot Token or Chat ID not configured. Skipping notification.', 'Telegram');
    return;
  }

  const dateStr = new Date(report.timestamp).toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' });
  
  const caption = `
🚨 *NEW EMERGENCY REPORT* 🚨
---------------------------
*Report ID:* ${report.id}
*Reporter:* ${report.reporterId}
*Time:* ${dateStr}
*Hostel/Dorm:* ${report.dorm || 'Not specified'}
*Description:* ${report.description || 'No additional details'}
*Status:* ${report.status.toUpperCase()}

⚠️ Please check Warden Dashboard immediately!
`;

  try {
    // If we have voiceUrl (base64 data), send it as a voice message
    if (report.voiceUrl && report.voiceUrl.startsWith('data:audio')) {
      const base64Data = report.voiceUrl.split(',')[1];
      const buffer = Buffer.from(base64Data, 'base64');
      
      const formData = new FormData();
      formData.append('chat_id', chatId);
      // We detect mime type from the data URL prefix if possible, default to webm
      const mimeType = report.voiceUrl.split(';')[0].split(':')[1] || 'audio/webm';
      const extension = mimeType.split('/')[1] || 'webm';
      
      formData.append('voice', new Blob([buffer], { type: mimeType }), `voice.${extension}`);
      formData.append('caption', caption);
      formData.append('parse_mode', 'Markdown');

      const response = await fetch(`https://api.telegram.org/bot${token}/sendVoice`, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        const errorData = await response.json();
        addLog('error', `Telegram failure (sendVoice): ${JSON.stringify(errorData)}`, 'Telegram');
        
        // Fallback to text message if voice fails (e.g. file too large or format issue)
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: caption + '\n\n*(Voice attachment failed to send)*',
            parse_mode: 'Markdown'
          })
        });
      } else {
        addLog('info', `Notification with Audio sent for report ${report.id}`, 'Telegram');
      }
    } else {
      // Fallback to text message if no audio
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: caption,
          parse_mode: 'Markdown'
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        addLog('error', `Telegram failure (sendMessage): ${JSON.stringify(errorData)}`, 'Telegram');
      } else {
        addLog('info', `Notification sent for report ${report.id}`, 'Telegram');
      }
    }
  } catch (err: any) {
    addLog('error', `Telegram connection error: ${err.message}`, 'Telegram');
  }
}

async function persistReport(report: any) {
  if (r2) {
    try {
      await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: `reports/${report.id}.json`,
        Body: JSON.stringify(report),
        ContentType: 'application/json'
      }));
    } catch (e: any) {
      addLog('error', `R2 persist report error: ${e.message}`, 'R2');
    }
  }
  
  // Send Telegram notification for new reports ONLY (not updates)
  if (report.status === 'pending') {
    sendTelegramNotification(report);
  }
}

async function persistSystemConfig() {
  const config = { featureFlags, isCctvActive, updatedAt: Date.now() };
  if (r2) {
    try {
      await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: 'config/system.json',
        Body: JSON.stringify(config),
        ContentType: 'application/json'
      }));
    } catch (e: any) {
      addLog('error', `R2 persist config error: ${e.message}`, 'R2');
    }
  }
}

async function persistUser(user: any) {
  if (r2) {
    try {
      await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: `users/${user.id}.json`,
        Body: JSON.stringify(user),
        ContentType: 'application/json'
      }));
    } catch (e: any) {
      addLog('error', `R2 persist user error: ${e.message}`, 'R2');
    }
  }
}

async function deleteUser(userId: string) {
  authorizedUsers = authorizedUsers.filter(u => u.id !== userId);
  if (r2) {
    try {
      await r2.send(new DeleteObjectCommand({
        Bucket: R2_BUCKET,
        Key: `users/${userId}.json`
      }));
    } catch (e: any) {
      addLog('error', `R2 delete user error: ${e.message}`, 'R2');
    }
  }
}

async function clearAllReports() {
  const oldReports = [...reports];
  reports = [];
  if (r2) {
    try {
      const keys = oldReports.map(r => ({ Key: `reports/${r.id}.json` }));
      if (keys.length > 0) {
        await r2.send(new DeleteObjectsCommand({
          Bucket: R2_BUCKET,
          Delete: { Objects: keys }
        }));
      }
    } catch (e: any) {
      addLog('error', `R2 clear reports error: ${e.message}`, 'R2');
    }
  }
}

async function startServer() {
  console.log('[System] Initializing server...');
  await loadInitialState().catch(err => console.error('[Storage] Initial load background failure:', err));
  await ensureSuperAdmin().catch(err => console.error('[System] Super admin check failed:', err));
  console.log('[System] State loaded or bypassed. Setting up Express...');

  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['polling', 'websocket'],
  });

  const PORT = Number(process.env.PORT) || 3000;

  app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
  app.use(express.json({ limit: '100mb' }));

  // Debug middleware to trace API access
  app.use((req, res, next) => {
    if (req.url.startsWith('/api')) {
      console.log(`[API LOG] ${req.method} ${req.url}`);
    }
    next();
  });

  // API Status
  app.get('/api/db-status', async (req, res) => {
    const status: any = {
      r2: r2 ? 'connected' : 'disconnected',
      telegram: (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) ? 'ready' : 'not_configured'
    };
    
    if (r2) {
      try {
        await r2.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, MaxKeys: 1 }));
        status.r2 = 'active';
      } catch (e: any) {
        status.r2 = 'error: ' + e.message;
      }
    }

    res.json(status);
  });

  app.get('/api/reports', (req, res) => res.json(reports));
  app.get('/api/cctv', (req, res) => res.json({ isCctvActive }));
  app.get('/api/system/logs', (req, res) => res.json(systemLogs));
  app.get('/api/system/config', (req, res) => res.json({ featureFlags, isCctvActive }));
  app.get('/api/users', (req, res) => res.json(authorizedUsers));
  app.get('/api/health', (req, res) => res.json({ status: 'ok', r2: !!r2 }));

  app.post('/api/system/config', async (req, res) => {
    const { featureFlags: newFlags, isCctvActive: newCctv } = req.body;
    if (newFlags) featureFlags = { ...featureFlags, ...newFlags };
    if (newCctv !== undefined) isCctvActive = newCctv;
    await persistSystemConfig();
    addLog('info', 'System configuration updated by Admin', 'Admin');
    res.json({ success: true });
  });

  app.post('/api/users', async (req, res) => {
    const newUser = req.body;
    authorizedUsers.push(newUser);
    await persistUser(newUser);
    addLog('info', `New ${newUser.role} added: ${newUser.id}`, 'Admin');
    res.json({ success: true });
  });

  app.delete('/api/users/:id', async (req, res) => {
    const { id } = req.params;
    await deleteUser(id);
    addLog('warn', `User removed: ${id}`, 'Admin');
    res.json({ success: true });
  });

  app.post('/api/reports', async (req, res) => {
    const report = req.body;
    if (reports.some(r => r.id === report.id)) return res.json(report);
    reports = [report, ...reports];
    await persistReport(report);
    io.emit('report_added', report);
    res.status(201).json(report);
  });

  io.on('connection', (socket) => {
    socket.emit('init', { reports, isCctvActive });

    socket.on('add_report', async (report) => {
      if (reports.some(r => r.id === report.id)) return;
      reports = [report, ...reports];
      await persistReport(report);
      io.emit('report_added', report);
    });

    socket.on('mark_reviewed', async (id) => {
      reports = reports.map(r => r.id === id ? { ...r, status: 'reviewed' } : r);
      const updated = reports.find(r => r.id === id);
      if (updated) await persistReport(updated);
      io.emit('reports_updated', reports);
    });

    socket.on('toggle_cctv', async () => {
      isCctvActive = !isCctvActive;
      await persistSystemConfig();
      io.emit('cctv_toggled', isCctvActive);
    });

    socket.on('clear_reports', async () => {
      await clearAllReports();
      io.emit('reports_cleared');
    });

    // --- WebRTC Signaling for CCTV ---
    socket.on('cctv_ready', () => {
      socket.broadcast.emit('cctv_available', { streamerId: socket.id });
      console.log(`[CCTV] Streamer Ready: ${socket.id}`);
    });

    socket.on('cctv_join', (streamerId) => {
      io.to(streamerId).emit('cctv_user_joined', { userId: socket.id });
      console.log(`[CCTV] User ${socket.id} joined streamer ${streamerId}`);
    });

    socket.on('cctv_signal', ({ to, signal }) => {
      io.to(to).emit('cctv_signal', { from: socket.id, signal });
    });

    socket.on('disconnect', () => {
      socket.broadcast.emit('cctv_unavailable', { streamerId: socket.id });
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res, next) => {
      // Ensure API and Socket.IO routes are never intercepted by SPA fallback
      if (req.url.startsWith('/api') || req.url.startsWith('/socket.io')) {
        return next();
      }
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Final catch-all error handler for API
  app.use((err: any, req: any, res: any, next: any) => {
    if (res.headersSent) return next(err);
    console.error('[CRITICAL SERVER ERROR]', err);
    if (req.url.startsWith('/api')) {
      return res.status(500).json({ error: 'Server Error', message: err.message });
    }
    next(err);
  });

  if (process.env.VERCEL !== '1') {
    httpServer.listen(PORT, '0.0.0.0', () => console.log(`Server running on http://0.0.0.0:${PORT}`));
  }
  return app;
}

const appPromise = startServer();
export default async (req: any, res: any) => {
  const app = await appPromise;
  return app(req, res);
};
