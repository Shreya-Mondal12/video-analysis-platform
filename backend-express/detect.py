#!/usr/bin/env python3
"""
YOLO Cat Detection Sidecar
--------------------------
Called by Node.js via child_process.spawn:
  python detect.py <image_path>

Outputs a single JSON line to stdout:
  {"label": "cat_present", "confidence": 0.94}

COCO class "cat" is detected by YOLOv8n (pretrained on COCO 80 classes).
"""

import sys
import json
import os


def detect(image_path: str) -> dict:
    from ultralytics import YOLO

    # Use local weights if already downloaded, otherwise auto-download
    model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "yolov8n.pt")
    model = YOLO(model_path if os.path.exists(model_path) else "yolov8n.pt")

    results = model(image_path, verbose=False)
    boxes = results[0].boxes

    best_conf = 0.0
    cat_found = False

    if boxes is not None and len(boxes):
        for cls_id, conf in zip(boxes.cls.tolist(), boxes.conf.tolist()):
            class_name = model.names[int(cls_id)]
            # Log every detected class to stderr for debugging
            print(f"[YOLO] detected: {class_name} ({conf:.2f})", file=sys.stderr)

            if class_name == "cat" and conf > 0.25:
                cat_found = True
                if conf > best_conf:
                    best_conf = conf

    return {
        "label": "cat_present" if cat_found else "cat_not_present",
        "confidence": round(best_conf, 4) if cat_found else 0.0,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python detect.py <image_path>"}))
        sys.exit(1)

    image_path = sys.argv[1]

    if not os.path.exists(image_path):
        print(json.dumps({"error": f"File not found: {image_path}"}))
        sys.exit(1)

    try:
        result = detect(image_path)
        print(json.dumps(result))
        sys.stdout.flush()
    except Exception as e:
        print(json.dumps({"label": "cat_not_present", "confidence": 0.0, "error": str(e)}))
        sys.stdout.flush()
        sys.exit(0)