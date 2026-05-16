#!/bin/bash
set -e
echo "🐱 VisionCat — YOLO Cat Detection Platform"
echo "==========================================="
echo ""

# Check Python deps
if ! python3 -c "import ultralytics" 2>/dev/null; then
  echo "📦 Installing Python dependencies (ultralytics + opencv)..."
  pip install ultralytics opencv-python-headless --break-system-packages -q
fi

cd "$(dirname "$0")/backend-express"

if [ ! -d "node_modules" ]; then
  echo "📦 Installing Node dependencies..."
  npm install
fi

echo "🚀 Starting server at http://localhost:8000"
echo "   YOLOv8n weights (~6MB) auto-download on first video processed."
echo ""
node server.js
