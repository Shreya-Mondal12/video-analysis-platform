
import cv2
import os
from datetime import datetime
from pathlib import Path
import logging

logger = logging.getLogger(__name__)

# Legacy helper utilities
# Actual detection pipeline now uses:
# Express.js + detect.py + YOLOv8 local inference

UPLOADS_DIR = Path("uploads")
FRAMES_DIR = Path("frames")
THUMBNAILS_DIR = Path("thumbnails")

for d in [UPLOADS_DIR, FRAMES_DIR, THUMBNAILS_DIR]:
    d.mkdir(exist_ok=True)


def get_video_metadata(video_path: str) -> dict:
    """Extract video metadata using OpenCV."""

    cap = cv2.VideoCapture(video_path)

    if not cap.isOpened():
        raise ValueError(f"Could not open video: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    duration = frame_count / fps if fps > 0 else 0

    cap.release()

    return {
        "fps": fps,
        "frame_count": frame_count,
        "width": width,
        "height": height,
        "duration": duration,
    }


def extract_thumbnail(video_path: str, video_id: int) -> str:
    """Extract a thumbnail from the first frame."""

    cap = cv2.VideoCapture(video_path)

    ret, frame = cap.read()

    cap.release()

    if not ret:
        return None

    thumb_path = THUMBNAILS_DIR / f"thumb_{video_id}.jpg"

    # Resize thumbnail
    h, w = frame.shape[:2]

    scale = 320 / max(w, h)

    frame = cv2.resize(
        frame,
        (int(w * scale), int(h * scale))
    )

    cv2.imwrite(
        str(thumb_path),
        frame,
        [cv2.IMWRITE_JPEG_QUALITY, 80]
    )

    return str(thumb_path)


async def process_video(video_id: int, video_path: str, db_session_factory):
    """
    Legacy async processing pipeline.

    Current production detection pipeline uses:
    processing.js + detect.py + YOLOv8 local inference.
    """

    from models import ProcessingJob

    db = db_session_factory()

    try:

        job = (
            db.query(ProcessingJob)
            .filter(ProcessingJob.video_id == video_id)
            .first()
        )

        if not job:
            logger.error(f"No job found for video {video_id}")
            return

        job.status = "processing"
        job.started_at = datetime.utcnow()

        db.commit()

        cap = cv2.VideoCapture(video_path)

        if not cap.isOpened():

            job.status = "failed"
            job.error_message = "Could not open video file"

            db.commit()

            return

        fps = cap.get(cv2.CAP_PROP_FPS)

        total_frames = int(
            cap.get(cv2.CAP_PROP_FRAME_COUNT)
        )

        # Sample ~1 frame/sec
        sample_interval = max(1, int(fps))

        sampled_frame_indices = list(
            range(0, total_frames, sample_interval)
        )

        job.total_frames = len(sampled_frame_indices)
        job.processed_frames = len(sampled_frame_indices)

        cap.release()

        job.status = "completed"
        job.completed_at = datetime.utcnow()

        db.commit()

        logger.info(
            f"Video {video_id} processing completed."
        )

    except Exception as e:

        logger.exception(
            f"Processing failed for video {video_id}: {e}"
        )

        try:

            job = (
                db.query(ProcessingJob)
                .filter(ProcessingJob.video_id == video_id)
                .first()
            )

            if job:
                job.status = "failed"
                job.error_message = str(e)

                db.commit()

        except:
            pass

    finally:
        db.close()

