const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { getDb, saveDb, dbAll, dbGet, dbRun } = require('./db');
const { getVideoMetadata, extractThumbnail, processVideo, UPLOADS_DIR, THUMBNAILS_DIR } = require('./processing');

const app = express();
const PORT = process.env.PORT || 8000;

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_DURATION = 60; // seconds
const ALLOWED_MIME = new Set([
  'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm', 'video/mpeg',
]);

// ── Middleware ─────────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

// Static file serving
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/thumbnails', express.static(THUMBNAILS_DIR));

// Serve pre-built React frontend
const STATIC_DIR = path.join(__dirname, 'static');
if (fs.existsSync(STATIC_DIR)) {
  app.use('/assets', express.static(path.join(STATIC_DIR, 'assets')));
}

// ── Multer (file upload) ───────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Use MP4, MOV, AVI, or WebM.`));
    }
  },
});

// ── Health ─────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── POST /api/videos — Upload ──────────────────────────────────────────────────

app.post('/api/videos', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ detail: 'File exceeds 50MB limit.' });
      return res.status(400).json({ detail: err.message });
    }

    if (!req.file) return res.status(400).json({ detail: 'No file uploaded.' });

    const filePath = req.file.path;

    try {
      const meta = await getVideoMetadata(filePath);

      if (meta.duration > MAX_DURATION) {
        fs.unlink(filePath, () => {});
        return res.status(400).json({
          detail: `Video exceeds 60-second limit (${meta.duration.toFixed(1)}s).`,
        });
      }

      // Insert video record
      const videoId = dbRun(
        `INSERT INTO videos (filename, original_name, file_size, duration, width, height, fps, file_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.file.filename,
          req.file.originalname,
          req.file.size,
          meta.duration,
          meta.width,
          meta.height,
          meta.fps,
          filePath,
        ]
      );

      // Extract thumbnail async (don't await — let it run)
      extractThumbnail(filePath, videoId).then((thumbPath) => {
        if (thumbPath) {
          dbRun(`UPDATE videos SET thumbnail_path=? WHERE id=?`, [thumbPath, videoId]);
        }
      });

      // Create processing job
      dbRun(`INSERT INTO processing_jobs (video_id, status) VALUES (?, 'pending')`, [videoId]);

      // Start background processing (fire-and-forget)
      setImmediate(() => {
        processVideo(videoId, filePath, { dbGet, dbRun, dbAll, saveDb }).catch(console.error);
      });

      const video = dbGet(`SELECT * FROM videos WHERE id=?`, [videoId]);
      res.status(201).json(formatVideo(video, 'pending'));
    } catch (e) {
      fs.unlink(filePath, () => {});
      console.error('Upload error:', e);
      res.status(500).json({ detail: `Processing error: ${e.message}` });
    }
  });
});

// ── GET /api/videos — List ─────────────────────────────────────────────────────

app.get('/api/videos', (req, res) => {
  const videos = dbAll(`SELECT * FROM videos ORDER BY created_at DESC`);

  const result = videos.map((v) => {
    const job = dbGet(
      `SELECT * FROM processing_jobs WHERE video_id=? ORDER BY created_at DESC LIMIT 1`,
      [v.id]
    );
    return formatVideo(v, job?.status || 'unknown', job);
  });

  res.json(result);
});

// ── GET /api/videos/:id — Detail ──────────────────────────────────────────────

app.get('/api/videos/:id', (req, res) => {
  const v = dbGet(`SELECT * FROM videos WHERE id=?`, [req.params.id]);
  if (!v) return res.status(404).json({ detail: 'Video not found' });

  const job = dbGet(
    `SELECT * FROM processing_jobs WHERE video_id=? ORDER BY created_at DESC LIMIT 1`,
    [v.id]
  );

  res.json({
    ...formatVideo(v, job?.status || 'unknown', job),
    video_url: `/uploads/${v.filename}`,
    error_message: job?.error_message || null,
    started_at: job?.started_at || null,
    completed_at: job?.completed_at || null,
  });
});

// ── DELETE /api/videos/:id ─────────────────────────────────────────────────────

app.delete('/api/videos/:id', (req, res) => {
  const v = dbGet(`SELECT * FROM videos WHERE id=?`, [req.params.id]);
  if (!v) return res.status(404).json({ detail: 'Video not found' });

  // Delete files
  [v.file_path, v.thumbnail_path].filter(Boolean).forEach((p) => fs.unlink(p, () => {}));

  // Cascade delete (jobs + predictions)
  dbRun(`DELETE FROM frame_predictions WHERE video_id=?`, [v.id]);
  dbRun(`DELETE FROM processing_jobs WHERE video_id=?`, [v.id]);
  dbRun(`DELETE FROM videos WHERE id=?`, [v.id]);

  res.json({ message: 'Deleted successfully' });
});

// ── GET /api/videos/:id/status ─────────────────────────────────────────────────

app.get('/api/videos/:id/status', (req, res) => {
  const job = dbGet(
    `SELECT * FROM processing_jobs WHERE video_id=? ORDER BY created_at DESC LIMIT 1`,
    [req.params.id]
  );
  if (!job) return res.status(404).json({ detail: 'No processing job found' });

  const progress =
    job.total_frames > 0 ? Math.round((job.processed_frames / job.total_frames) * 100) : 0;

  res.json({
    video_id: parseInt(req.params.id),
    status: job.status,
    total_frames: job.total_frames,
    processed_frames: job.processed_frames,
    progress,
    error_message: job.error_message || null,
    started_at: job.started_at || null,
    completed_at: job.completed_at || null,
  });
});

// ── GET /api/videos/:id/predictions ────────────────────────────────────────────

app.get('/api/videos/:id/predictions', (req, res) => {
  const v = dbGet(`SELECT * FROM videos WHERE id=?`, [req.params.id]);
  if (!v) return res.status(404).json({ detail: 'Video not found' });

  const predictions = dbAll(
    `SELECT * FROM frame_predictions WHERE video_id=? ORDER BY timestamp ASC`,
    [v.id]
  );

  const catFrames = predictions.filter((p) => p.label === 'cat_present');

  res.json({
    video_id: v.id,
    total_frames_analyzed: predictions.length,
    cat_present_count: catFrames.length,
    cat_not_present_count: predictions.length - catFrames.length,
    cat_detection_rate: predictions.length > 0 ? catFrames.length / predictions.length : 0,
    predictions: predictions.map((p) => ({
      id: p.id,
      timestamp: p.timestamp,
      frame_number: p.frame_number,
      label: p.label,
      confidence: p.confidence,
    })),
  });
});

// ── Frontend catch-all ─────────────────────────────────────────────────────────

if (fs.existsSync(STATIC_DIR)) {
  app.get('/', (req, res) => res.sendFile(path.join(STATIC_DIR, 'index.html')));
  app.get(/^\/(?!api|uploads|thumbnails|health|assets).*/, (req, res) => {
    res.sendFile(path.join(STATIC_DIR, 'index.html'));
  });
}

// ── Error handler ──────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ detail: err.message || 'Internal server error' });
});

// ── Start ──────────────────────────────────────────────────────────────────────

async function start() {
  await getDb(); // initialise DB + schema
  app.listen(PORT, () => {
    console.log(`\n🐱 VisionCat (Express) running at http://localhost:${PORT}`);
    console.log(`   API docs preview: http://localhost:${PORT}/health\n`);
  });
}

start().catch(console.error);

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatVideo(v, status, job = null) {
  return {
    id: v.id,
    filename: v.filename,
    original_name: v.original_name,
    file_size: v.file_size,
    duration: v.duration,
    width: v.width,
    height: v.height,
    fps: v.fps,
    created_at: v.created_at,
    thumbnail_url: v.thumbnail_path ? `/thumbnails/thumb_${v.id}.jpg` : null,
    video_url: `/uploads/${v.filename}`,
    status,
    processed_frames: job?.processed_frames || 0,
    total_frames: job?.total_frames || 0,
  };
}
