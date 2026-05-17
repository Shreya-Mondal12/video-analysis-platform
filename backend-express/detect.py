#!/usr/bin/env python3
import sys, json, os

def load_model():
    from ultralytics import YOLO
    model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "yolov8n.pt")
    model = YOLO(model_path if os.path.exists(model_path) else "yolov8n.pt")
    print(json.dumps({"ready": True}), flush=True)
    return model

def detect(model, image_path):
    if not os.path.exists(image_path):
        return {"label": "cat_not_present", "confidence": 0.0}
    results = model(image_path, verbose=False, imgsz=640)
    boxes = results[0].boxes
    best_conf = 0.0
    cat_found = False
    if boxes is not None and len(boxes):
        for cls_id, conf in zip(boxes.cls.tolist(), boxes.conf.tolist()):
            name = model.names[int(cls_id)]
            print(f"[YOLO] {name} {conf:.2f}", file=sys.stderr, flush=True)
            if name == "cat" and conf > 0.20:
                cat_found = True
                if conf > best_conf:
                    best_conf = conf
    return {
        "label": "cat_present" if cat_found else "cat_not_present",
        "confidence": round(best_conf, 4) if cat_found else 0.0,
    }

if __name__ == "__main__":
    try:
        model = load_model()
    except Exception as e:
        print(json.dumps({"error": str(e)}), flush=True)
        sys.exit(1)

    for line in sys.stdin:
        image_path = line.strip()
        if not image_path:
            continue
        try:
            print(json.dumps(detect(model, image_path)), flush=True)
        except Exception as e:
            print(json.dumps({"label": "cat_not_present", "confidence": 0.0, "error": str(e)}), flush=True)