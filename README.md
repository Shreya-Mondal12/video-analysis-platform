#  VisionCat — Video Analysis Platform

A full-stack video analysis platform that detects cat presence in video frames using **YOLOv8** — runs fully locally, no API key needed, no cost per frame.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                              │
│              React SPA (Vite + CSS Variables)               │
│                                                             │
│  Sidebar          │  Video Player   │  Analysis Panel       │
│  ├─ Upload zone   │  ├─ Controls    │  ├─ Donut charts      │
│  ├─ Video library │  ├─ Stats bar   │  ├─ Detection timeline│
│  └─ Mini progress │  └─ Seek sync   │  └─ Predictions table │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP / REST
┌──────────────────────▼──────────────────────────────────────┐
│               Express.js Backend (Node.js)                  │
│                                                             │
│  POST   /api/videos                 ← upload + validate     │
│  GET    /api/videos                 ← list all videos       │
│  GET    /api/videos/:id             ← video detail          │
│  GET    /api/videos/:id/status      ← processing progress   │
│  GET    /api/videos/:id/predictions ← frame results         │
│  DELETE /api/videos/:id             ← delete video + data   │
│                                                             │
│  setImmediate() → processVideo()  [background, non-blocking]│
│    ├── fluent-ffmpeg : extract 1 frame/sec as JPEG          │
│    ├── spawn python  : YOLO classifies frame via detect.py  │
│    │     └── ultralytics YOLOv8n : COCO cat class           │
│    └── sql.js (SQLite) : store predictions                  │
└──────────────────────┬──────────────────────────────────────┘
                       │
          ┌────────────┴───────────┐
          │                        │
   ┌──────▼──────┐          ┌──────▼──────┐
   │   SQLite DB  │          │  File System │
   │  videos      │          │  uploads/   │
   │  proc_jobs   │          │  thumbnails/│
   │  frame_pred  │          │  frames/    │
   └─────────────┘          │  (deleted   │
                             │  after use) │
                             └─────────────┘
```

### Technology Stack

| Layer      | Technology                                        |
|------------|---------------------------------------------------|
| Frontend   | React 18, Vite, CSS Variables                     |
| Backend    | Express.js 4, Node.js, Multer                    |
| Database   | SQLite via sql.js (pure JS, no native build)      |
| Detection  | YOLOv8n (ultralytics) — COCO pretrained, local    |
| Video      | fluent-ffmpeg + system ffmpeg                     |
| IPC        | Node child_process.spawn → python detect.py       |
| Storage    | Local filesystem                                  |

---

## Why No API Key?

YOLO runs **entirely on your machine** — no internet, no billing, no authentication.

```
Cloud AI  →  Your app → internet → company's server → result   (costs money = needs key)
Local AI  →  Your app → Python on your CPU → result            (your hardware = free)
```

yolov8n.pt is a 6MB weights file downloaded once from Ultralytics. After that the model runs offline forever. Ultralytics trained it on 120k images so you don't have to — you just load the result and run inference.

---

## Setup Instructions

### Prerequisites

- **Node.js 18+**
- **Python 3.9+** with pip
- **ffmpeg** installed and on PATH
  - Windows: `winget install ffmpeg`
  - Mac: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg`
- No API key required

### 1. Install Python dependencies

```bash
pip install ultralytics opencv-python-headless
```

> yolov8n.pt (~6MB) auto-downloads on the first video processed.

### 2. Install Node dependencies

```bash
cd backend-express
npm install
```

### 3. Start the server

```bash
node server.js
```

Open **http://localhost:8000**

---

## Frontend Development

The built frontend is served by Express from `backend-express/static/`.
When you edit React source files, rebuild and copy manually:

```bash
# Windows (run from frontend/ folder)
npm run build && xcopy /E /Y dist\* ..\backend-express\static\

# Mac/Linux
npm run build && cp -r dist/* ../backend-express/static/
```

For live hot-reload during development, run the Vite dev server separately:

```bash
cd frontend
npm run dev    # http://localhost:5173  (proxies /api calls to :8000)
```

Keep `node server.js` running in one terminal and `npm run dev` in another.
Work on `:5173` for instant feedback, then build + copy when done to update `:8000`.

---

## How YOLO Detection Works

```
ffmpeg seek → frame.jpg → python detect.py frame.jpg → JSON stdout → Node parses → SQLite
```

detect.py is a Python sidecar script spawned by Node as a child process for every frame.
It loads YOLOv8n, runs inference, and prints a single JSON line to stdout. Node reads it and stores the result.

```python
model = YOLO("yolov8n.pt")
results = model(image_path, verbose=False)
# COCO class "cat" triggers cat_present
# highest confidence box is returned
```

**Cross-platform Python command:**
Windows uses `python`, Mac/Linux use `python3`. This is detected automatically:

```js
const PYTHON = process.platform === 'win32' ? 'python' : 'python3'
```

---

## Dashboard Features

- **Upload zone** — drag-and-drop or click, with live XHR progress bar
- **Video library** — thumbnails, duration, file size, live status badge, mini progress bar per video during processing
- **Video player** — native controls with metadata bar (duration, resolution, FPS, size)
- **Summary cards** — animated SVG donut charts for detection rate % and average confidence %
- **Detection timeline** — color-coded segments (green = cat, dark = no cat), hover tooltip shows timestamp + confidence, click any segment to seek the video to that exact moment
- **Predictions table** — timestamp, frame number, label badge, confidence bar, ▶ seek button per row that jumps the player
- **Auto-polling** — status and predictions refresh every 2 seconds while a video is processing

---

## API Reference

| Method   | Endpoint                          | Description              |
|----------|-----------------------------------|--------------------------|
| GET      | /health                           | Health check             |
| POST     | /api/videos                       | Upload video (multipart) |
| GET      | /api/videos                       | List all videos          |
| GET      | /api/videos/:id                   | Video detail + status    |
| GET      | /api/videos/:id/status            | Processing progress      |
| GET      | /api/videos/:id/predictions       | Frame predictions        |
| DELETE   | /api/videos/:id                   | Delete video + all data  |

### Sample prediction response

```json
{
  "video_id": 1,
  "total_frames_analyzed": 9,
  "cat_present_count": 9,
  "cat_not_present_count": 0,
  "cat_detection_rate": 1.0,
  "predictions": [
    { "timestamp": 0.0, "frame_number": 0,  "label": "cat_present", "confidence": 0.93 },
    { "timestamp": 1.0, "frame_number": 60, "label": "cat_present", "confidence": 0.92 }
  ]
}
```

---

## Database Schema

```sql
-- One row per uploaded video
CREATE TABLE videos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  filename       TEXT,         -- UUID-based stored name
  original_name  TEXT,         -- user's original filename
  file_size      INTEGER,
  duration       REAL,         -- seconds
  width          INTEGER,
  height         INTEGER,
  fps            REAL,
  file_path      TEXT,
  thumbnail_path TEXT,
  created_at     TEXT
);

-- Tracks async processing state per video
CREATE TABLE processing_jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id         INTEGER,
  status           TEXT,   -- pending | processing | completed | failed
  total_frames     INTEGER,
  processed_frames INTEGER,
  error_message    TEXT,
  started_at       TEXT,
  completed_at     TEXT,
  created_at       TEXT
);

-- One row per sampled frame (~1 per second)
CREATE TABLE frame_predictions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id     INTEGER,
  timestamp    REAL,    -- seconds from start
  frame_number INTEGER,
  label        TEXT,    -- cat_present | cat_not_present
  confidence   REAL,    -- 0.0 - 1.0 from YOLO
  created_at   TEXT
);
```

---

## Constraints

| Constraint | Value |
|---|---|
| Max video duration | 60 seconds |
| Max file size | 50 MB |
| Accepted formats | MP4, MOV, AVI, WebM |
| Frame sampling rate | ~1 frame/second |
| Confidence threshold | 0.25 (detections below this are ignored) |

---

## Deployment

### Docker

```bash
docker build -t visioncat .
docker run -p 8000:8000 visioncat
```

The Dockerfile installs ffmpeg, Python + ultralytics, and Node in one image.

### Render / Railway

1. Push repo to GitHub
2. New Web Service → root directory: `backend-express/`
3. Build command: `pip install ultralytics opencv-python-headless && npm install`
4. Start command: `node server.js`
5. Add env var: `PORT=8000`
6. Mount a persistent disk at `/app/uploads` so videos survive redeploys

---
