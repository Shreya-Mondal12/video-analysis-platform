import os
import uuid
import asyncio
import logging
from pathlib import Path
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, File, UploadFile, HTTPException, Depends, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from database import get_db, init_db, SessionLocal
from models import Video, ProcessingJob, FramePrediction
from processing import (
    get_video_metadata, extract_thumbnail,
    process_video, UPLOADS_DIR, THUMBNAILS_DIR, FRAMES_DIR
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Video Analysis API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files
for d in [UPLOADS_DIR, THUMBNAILS_DIR, FRAMES_DIR]:
    d.mkdir(exist_ok=True)

app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")
app.mount("/thumbnails", StaticFiles(directory="thumbnails"), name="thumbnails")
app.mount("/frames", StaticFiles(directory="frames"), name="frames")

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB
MAX_DURATION = 60  # seconds
ALLOWED_TYPES = {"video/mp4", "video/quicktime", "video/x-msvideo", "video/webm", "video/mpeg"}


@app.on_event("startup")
async def startup():
    init_db()
    logger.info("Database initialized")


@app.get("/health")
def health():
    return {"status": "ok", "timestamp": datetime.utcnow().isoformat()}


# ─── Video Upload ──────────────────────────────────────────────────────────────

@app.post("/api/videos")
async def upload_video(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    db: Session = Depends(get_db)
):
    """Upload a video file and kick off background processing."""
    # Validate content type
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(400, f"Unsupported file type: {file.content_type}. Allowed: mp4, mov, avi, webm")

    # Read and validate size
    contents = await file.read()
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(400, f"File exceeds 50MB limit ({len(contents) / 1024 / 1024:.1f}MB)")

    # Save file
    ext = Path(file.filename).suffix or ".mp4"
    unique_name = f"{uuid.uuid4()}{ext}"
    file_path = UPLOADS_DIR / unique_name

    with open(file_path, "wb") as f:
        f.write(contents)

    # Get metadata
    try:
        meta = get_video_metadata(str(file_path))
    except Exception as e:
        file_path.unlink(missing_ok=True)
        raise HTTPException(400, f"Could not read video metadata: {e}")

    if meta["duration"] > MAX_DURATION:
        file_path.unlink(missing_ok=True)
        raise HTTPException(400, f"Video exceeds 60-second limit ({meta['duration']:.1f}s)")

    # Create DB record
    video = Video(
        filename=unique_name,
        original_name=file.filename,
        file_size=len(contents),
        duration=meta["duration"],
        width=meta["width"],
        height=meta["height"],
        fps=meta["fps"],
        file_path=str(file_path),
    )
    db.add(video)
    db.flush()

    # Extract thumbnail
    try:
        thumb = extract_thumbnail(str(file_path), video.id)
        video.thumbnail_path = thumb
    except Exception:
        pass

    # Create processing job
    job = ProcessingJob(video_id=video.id, status="pending")
    db.add(job)
    db.commit()
    db.refresh(video)

    # Kick off async processing
    background_tasks.add_task(
        run_processing, video.id, str(file_path)
    )

    return {
        "id": video.id,
        "filename": video.filename,
        "original_name": video.original_name,
        "file_size": video.file_size,
        "duration": video.duration,
        "width": video.width,
        "height": video.height,
        "fps": video.fps,
        "created_at": video.created_at.isoformat(),
        "thumbnail_url": f"/thumbnails/thumb_{video.id}.jpg" if video.thumbnail_path else None,
        "status": "pending",
    }


async def run_processing(video_id: int, file_path: str):
    """Wrapper to run async processing in background."""
    await process_video(video_id, file_path, SessionLocal)


# ─── Videos List ──────────────────────────────────────────────────────────────

@app.get("/api/videos")
def list_videos(db: Session = Depends(get_db)):
    """List all uploaded videos with their latest job status."""
    videos = db.query(Video).order_by(Video.created_at.desc()).all()
    result = []
    for v in videos:
        job = (
            db.query(ProcessingJob)
            .filter(ProcessingJob.video_id == v.id)
            .order_by(ProcessingJob.created_at.desc())
            .first()
        )
        result.append({
            "id": v.id,
            "original_name": v.original_name,
            "file_size": v.file_size,
            "duration": v.duration,
            "width": v.width,
            "height": v.height,
            "fps": v.fps,
            "created_at": v.created_at.isoformat(),
            "thumbnail_url": f"/thumbnails/thumb_{v.id}.jpg" if v.thumbnail_path else None,
            "video_url": f"/uploads/{v.filename}",
            "status": job.status if job else "unknown",
            "processed_frames": job.processed_frames if job else 0,
            "total_frames": job.total_frames if job else 0,
        })
    return result


@app.get("/api/videos/{video_id}")
def get_video(video_id: int, db: Session = Depends(get_db)):
    """Get a single video's details."""
    v = db.query(Video).filter(Video.id == video_id).first()
    if not v:
        raise HTTPException(404, "Video not found")

    job = (
        db.query(ProcessingJob)
        .filter(ProcessingJob.video_id == v.id)
        .order_by(ProcessingJob.created_at.desc())
        .first()
    )
    return {
        "id": v.id,
        "original_name": v.original_name,
        "filename": v.filename,
        "file_size": v.file_size,
        "duration": v.duration,
        "width": v.width,
        "height": v.height,
        "fps": v.fps,
        "created_at": v.created_at.isoformat(),
        "thumbnail_url": f"/thumbnails/thumb_{v.id}.jpg" if v.thumbnail_path else None,
        "video_url": f"/uploads/{v.filename}",
        "status": job.status if job else "unknown",
        "processed_frames": job.processed_frames if job else 0,
        "total_frames": job.total_frames if job else 0,
        "error_message": job.error_message if job else None,
        "started_at": job.started_at.isoformat() if job and job.started_at else None,
        "completed_at": job.completed_at.isoformat() if job and job.completed_at else None,
    }


@app.delete("/api/videos/{video_id}")
def delete_video(video_id: int, db: Session = Depends(get_db)):
    """Delete a video and all associated data."""
    v = db.query(Video).filter(Video.id == video_id).first()
    if not v:
        raise HTTPException(404, "Video not found")
    
    # Delete files
    try:
        Path(v.file_path).unlink(missing_ok=True)
        if v.thumbnail_path:
            Path(v.thumbnail_path).unlink(missing_ok=True)
    except Exception:
        pass

    db.delete(v)
    db.commit()
    return {"message": "Deleted successfully"}


# ─── Processing Status ─────────────────────────────────────────────────────────

@app.get("/api/videos/{video_id}/status")
def get_status(video_id: int, db: Session = Depends(get_db)):
    """Get processing status for a video."""
    job = (
        db.query(ProcessingJob)
        .filter(ProcessingJob.video_id == video_id)
        .order_by(ProcessingJob.created_at.desc())
        .first()
    )
    if not job:
        raise HTTPException(404, "No processing job found")

    progress = 0
    if job.total_frames > 0:
        progress = int((job.processed_frames / job.total_frames) * 100)

    return {
        "video_id": video_id,
        "status": job.status,
        "total_frames": job.total_frames,
        "processed_frames": job.processed_frames,
        "progress": progress,
        "error_message": job.error_message,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
    }


# ─── Predictions ───────────────────────────────────────────────────────────────

@app.get("/api/videos/{video_id}/predictions")
def get_predictions(video_id: int, db: Session = Depends(get_db)):
    """Get all frame-level predictions for a video."""
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(404, "Video not found")

    predictions = (
        db.query(FramePrediction)
        .filter(FramePrediction.video_id == video_id)
        .order_by(FramePrediction.timestamp)
        .all()
    )

    cat_frames = [p for p in predictions if p.label == "cat_present"]
    total = len(predictions)

    return {
        "video_id": video_id,
        "total_frames_analyzed": total,
        "cat_present_count": len(cat_frames),
        "cat_not_present_count": total - len(cat_frames),
        "cat_detection_rate": len(cat_frames) / total if total > 0 else 0,
        "predictions": [
            {
                "id": p.id,
                "timestamp": p.timestamp,
                "frame_number": p.frame_number,
                "label": p.label,
                "confidence": p.confidence,
            }
            for p in predictions
        ]
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)

# Serve frontend static files (production)
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles as FS
import os

STATIC_DIR = Path("static")
if STATIC_DIR.exists():
    app.mount("/assets", FS(directory="static/assets"), name="frontend-assets")

    @app.get("/", response_class=HTMLResponse)
    async def serve_frontend():
        with open("static/index.html") as f:
            return f.read()

    @app.get("/{full_path:path}", response_class=HTMLResponse)
    async def catch_all(full_path: str):
        # Don't catch API routes
        if full_path.startswith("api/") or full_path.startswith("uploads/") or full_path.startswith("thumbnails/"):
            raise HTTPException(404)
        with open("static/index.html") as f:
            return f.read()
