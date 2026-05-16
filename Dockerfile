FROM node:22-slim

# Install Python, pip, ffmpeg
RUN apt-get update && apt-get install -y \
    python3 python3-pip ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install YOLO (downloads model weights on first run)
RUN pip3 install ultralytics opencv-python-headless --break-system-packages

WORKDIR /app

COPY backend-express/package.json .
RUN npm install --omit=dev

COPY backend-express/ .
COPY frontend/dist/ static/

RUN mkdir -p uploads thumbnails frames

EXPOSE 8000
CMD ["node", "server.js"]
