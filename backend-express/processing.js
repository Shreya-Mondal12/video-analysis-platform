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
      .size('512x?')
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .run();
  });
}

// ── YOLO via Python sidecar ─────────────────────────────────────────────────────
function classifyFrameWithYOLO(imagePath) {
  return new Promise((resolve) => {
    const fallback = { label: 'cat_not_present', confidence: 0.0 };
    const py = spawn(process.platform === 'win32' ? 'python' : 'python3', [DETECT_SCRIPT, imagePath]);
    let stdout = '';
    let stderr = '';
    py.stdout.on('data', chunk => stdout += chunk.toString());
    py.stderr.on('data', chunk => stderr += chunk.toString());
    py.on('close', () => {

  if (stderr) {
    console.error('YOLO stderr:', stderr.slice(0, 500));
  }

  try {
    const line = stdout.trim().split('\n').pop();

    const result = JSON.parse(line);

    if (result.error) {
      console.warn('YOLO sidecar warning:', result.error);
    }

    resolve({
      label: result.label || fallback.label,
      confidence:
        typeof result.confidence === 'number'
          ? result.confidence
          : 0.0,
    });

  } catch (e) {

    console.error(
      'YOLO parse error:',
      e.message,
      stdout.slice(0, 200)
    );

    resolve(fallback);
  }
});
    py.on('error', err => { console.error('Failed to spawn python3:', err.message); resolve(fallback); });
    setTimeout(() => { py.kill(); resolve(fallback); }, 30000);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Main pipeline ───────────────────────────────────────────────────────────────
async function processVideo(videoId, filePath, { dbGet, dbRun, dbAll, saveDb }) {
  const now = () => new Date().toISOString();
  try {
    dbRun(`UPDATE processing_jobs SET status='processing', started_at=? WHERE video_id=?`, [now(), videoId]);

    const { fps, duration } = await getVideoMetadata(filePath);
    const timestamps = [];
    for (let t = 0; t < duration; t += 1) timestamps.push(parseFloat(t.toFixed(2)));

    dbRun(`UPDATE processing_jobs SET total_frames=? WHERE video_id=?`, [timestamps.length, videoId]);

    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const frameNum = Math.round(ts * fps);
      const framePath = path.join(FRAMES_DIR, `${videoId}_${frameNum}.jpg`);
      try {
        await extractFrame(filePath, ts, framePath);
        const result = await classifyFrameWithYOLO(framePath);
        dbRun(
          `INSERT INTO frame_predictions (video_id, timestamp, frame_number, label, confidence) VALUES (?, ?, ?, ?, ?)`,
          [videoId, ts, frameNum, result.label, result.confidence]
        );
        fs.unlink(framePath, () => {});
      } catch (frameErr) {
        console.error(`Frame error at ${ts}s:`, frameErr.message);
        dbRun(
          `INSERT INTO frame_predictions (video_id, timestamp, frame_number, label, confidence) VALUES (?, ?, ?, ?, ?)`,
          [videoId, ts, frameNum, 'cat_not_present', 0.0]
        );
      }
      dbRun(`UPDATE processing_jobs SET processed_frames=? WHERE video_id=?`, [i + 1, videoId]);
    }

    dbRun(`UPDATE processing_jobs SET status='completed', completed_at=? WHERE video_id=?`, [now(), videoId]);
    console.log(`✅  Video ${videoId} done — ${timestamps.length} frames via YOLO`);
  } catch (err) {
    console.error(`❌  Video ${videoId} failed:`, err.message);
    dbRun(`UPDATE processing_jobs SET status='failed', error_message=? WHERE video_id=?`, [err.message, videoId]);
  }
}

module.exports = { getVideoMetadata, extractThumbnail, processVideo, UPLOADS_DIR, THUMBNAILS_DIR };
