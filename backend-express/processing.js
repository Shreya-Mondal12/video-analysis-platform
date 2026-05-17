const ffmpeg = require('fluent-ffmpeg');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const THUMBNAILS_DIR = path.join(__dirname, 'thumbnails');
const FRAMES_DIR = path.join(__dirname, 'frames');

for (const d of [UPLOADS_DIR, THUMBNAILS_DIR, FRAMES_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const DETECT_SCRIPT = path.join(__dirname, 'detect.py');

// ── Persistent YOLO sidecar ─────────────────────────────────────────────────────
let _proc = null;
let _ready = false;
let _readyCallbacks = [];
let _pendingResolves = [];
let _buf = '';

function getSidecar() {
  if (_proc) return _proc;
  const py = process.platform === 'win32' ? 'python' : 'python3';
  _proc = spawn(py, [DETECT_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
  _buf = '';

  _proc.stdout.on('data', (chunk) => {
    _buf += chunk.toString();
    const lines = _buf.split('\n');
    _buf = lines.pop();
    for (const line of lines) {
  const trimmed = line.trim();

  if (!trimmed) continue;

  // Ignore non-JSON logs/warnings
  if (!trimmed.startsWith('{')) {
    continue;
  }

  let msg;

  try {
    msg = JSON.parse(trimmed);
  } catch (e) {
    console.error('[YOLO] bad JSON:', trimmed.slice(0, 100));

    const r = _pendingResolves.shift();

    if (r) {
      r({
        label: 'cat_not_present',
        confidence: 0.0
      });
    }

    continue;
  }
      if (msg.ready) {
        _ready = true;
        console.log('[YOLO] sidecar ready');
        _readyCallbacks.forEach(cb => cb());
        _readyCallbacks = [];
      } else {
        const r = _pendingResolves.shift();
        if (r) r(msg);
      }
    }
  });

  _proc.stderr.on('data', (d) => {
    const t = d.toString().trim();
    if (
  t.includes('detected:') ||
  t.includes('loading model')
) {
  console.log('[YOLO]', t);
}
  });

  _proc.on('close', (code) => {
    console.warn(`[YOLO] exited (${code}), restarting on next request`);
    _proc = null; _ready = false;
    _pendingResolves.forEach(r => r({ label: 'cat_not_present', confidence: 0.0 }));
    _pendingResolves = [];
  });

  _proc.on('error', (err) => {
    console.error('[YOLO] spawn error:', err.message);
    _proc = null; _ready = false;
  });

  return _proc;
}

function classifyFrame(imagePath) {
  return new Promise((resolve) => {
    const proc = getSidecar();
    const run = () => {
      _pendingResolves.push(resolve);
      proc.stdin.write(imagePath + '\n');
    };
    if (_ready) {
      run();
    } else {
      let fired = false;
      const timer = setTimeout(() => {
        if (!fired) { fired = true; console.error('[YOLO] ready timeout'); resolve({ label: 'cat_not_present', confidence: 0.0 }); }
      }, 20000);
      _readyCallbacks.push(() => {
        if (!fired) { fired = true; clearTimeout(timer); run(); }
      });
    }
  });
}

// Pre-warm on startup
getSidecar();

// ── Video Metadata ──────────────────────────────────────────────────────────────
function getVideoMetadata(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const stream = metadata.streams.find(s => s.codec_type === 'video');
      if (!stream) return reject(new Error('No video stream found'));
      const [num, den] = (stream.r_frame_rate || '25/1').split('/').map(Number);
      const fps = parseFloat((num / den).toFixed(3));
      const duration = parseFloat(metadata.format.duration || 0);
      resolve({ fps, duration, width: stream.width, height: stream.height });
    });
  });
}

// ── Thumbnail ───────────────────────────────────────────────────────────────────
function extractThumbnail(filePath, videoId) {
  const thumbName = `thumb_${videoId}.jpg`;
  const thumbPath = path.join(THUMBNAILS_DIR, thumbName);
  return new Promise((resolve) => {
    ffmpeg(filePath)
      .screenshots({ timestamps: ['5%'], filename: thumbName, folder: THUMBNAILS_DIR, size: '320x?' })
      .on('end', () => resolve(thumbPath))
      .on('error', () => resolve(null));
  });
}

// ── Frame extraction ────────────────────────────────────────────────────────────
function extractFrame(filePath, timestamp, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .seekInput(timestamp)
      .frames(1)
      .outputOptions(['-vf', 'scale=416:416:force_original_aspect_ratio=decrease,pad=640:640:(ow-iw)/2:(oh-ih)/2'])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .run();
  });
}

// ── Main pipeline ───────────────────────────────────────────────────────────────
async function processVideo(videoId, filePath, { dbGet, dbRun, dbAll, saveDb }) {
  const now = () => new Date().toISOString();
  try {
    dbRun(`UPDATE processing_jobs SET status='processing', started_at=? WHERE video_id=?`, [now(), videoId]);
    const { fps, duration } = await getVideoMetadata(filePath);
    const timestamps = [];
    for (let t = 0; t < duration; t += 1) timestamps.push(parseFloat(t.toFixed(2)));
    dbRun(`UPDATE processing_jobs SET total_frames=? WHERE video_id=?`, [timestamps.length, videoId]);
    console.log(`[Video ${videoId}] ${timestamps.length} frames to process`);

    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const frameNum = Math.round(ts * fps);
      const framePath = path.join(FRAMES_DIR, `${videoId}_${frameNum}.jpg`);
      try {
        await extractFrame(filePath, ts, framePath);
        const result = await classifyFrame(framePath);
        console.log(`[Video ${videoId}] t=${ts}s → ${result.label} (${(result.confidence*100).toFixed(0)}%)`);
        dbRun(
          `INSERT INTO frame_predictions (video_id, timestamp, frame_number, label, confidence) VALUES (?, ?, ?, ?, ?)`,
          [videoId, ts, frameNum, result.label, result.confidence]
        );
        fs.unlink(framePath, () => {});
      } catch (frameErr) {
        console.error(`[Video ${videoId}] frame error at ${ts}s:`, frameErr.message);
        dbRun(
          `INSERT INTO frame_predictions (video_id, timestamp, frame_number, label, confidence) VALUES (?, ?, ?, ?, ?)`,
          [videoId, ts, frameNum, 'cat_not_present', 0.0]
        );
      }
      dbRun(`UPDATE processing_jobs SET processed_frames=? WHERE video_id=?`, [i + 1, videoId]);
    }

    dbRun(`UPDATE processing_jobs SET status='completed', completed_at=? WHERE video_id=?`, [now(), videoId]);
    console.log(`✅ Video ${videoId} done`);
  } catch (err) {
    console.error(`❌ Video ${videoId} failed:`, err.message);
    dbRun(`UPDATE processing_jobs SET status='failed', error_message=? WHERE video_id=?`, [err.message, videoId]);
  }
}

module.exports = { getVideoMetadata, extractThumbnail, processVideo, UPLOADS_DIR, THUMBNAILS_DIR };