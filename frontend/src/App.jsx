import { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'
const API = import.meta.env.VITE_API_URL || ''

function formatDuration(s) {
  if (!s) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}
function formatBytes(b) {
  if (!b) return '0 B'
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'
  return (b / 1048576).toFixed(1) + ' MB'
}
function formatTimestamp(t) {
  if (t == null) return '—'
  const m = Math.floor(t / 60)
  const s = (t % 60).toFixed(1)
  return `${m}:${s.padStart(4, '0')}`
}

function UploadZone({ onUploaded }) {
  const inputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)

  const upload = (file) => {
    setError(null)
    if (!file) return
    const ALLOWED = ['video/mp4','video/quicktime','video/x-msvideo','video/webm','video/mpeg']
    if (!ALLOWED.includes(file.type)) { setError('Unsupported format. Use MP4, MOV, AVI, or WebM.'); return }
    if (file.size > 50*1024*1024) { setError('File exceeds 50MB limit.'); return }
    setUploading(true); setProgress(10)
    const form = new FormData()
    form.append('file', file)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/videos`)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(Math.round(e.loaded/e.total*90)) }
    xhr.onload = () => {
      setProgress(100)
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = JSON.parse(xhr.responseText)
        onUploaded(data)
        setTimeout(() => { setUploading(false); setProgress(0) }, 800)
      } else {
        const err = JSON.parse(xhr.responseText)
        setError(err.detail || 'Upload failed')
        setUploading(false); setProgress(0)
      }
    }
    xhr.onerror = () => { setError('Network error'); setUploading(false); setProgress(0) }
    xhr.send(form)
  }

  return (
    <div>
      <div
        className={`upload-zone ${dragOver ? 'drag-over' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files[0]) }}
        onClick={() => !uploading && inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" accept="video/*" onChange={e => upload(e.target.files[0])} />
        <div className="upload-icon">⬆</div>
        <div className="upload-text">{uploading ? 'Uploading…' : 'Drop video here'}</div>
        <div className="upload-subtext">MP4 · MOV · AVI · WebM · max 60s · 50MB</div>
        {uploading && (
          <div className="upload-progress">
            <div className="progress-bar-bg"><div className="progress-bar-fill" style={{width:`${progress}%`}} /></div>
            <div className="progress-label">{progress}%</div>
          </div>
        )}
      </div>
      {error && <div className="error-box" style={{marginTop:10,fontSize:12}}>⚠ {error}</div>}
    </div>
  )
}

function VideoItem({ video, active, onClick, onDelete }) {
  return (
    <div className={`video-item ${active ? 'active' : ''}`} onClick={onClick}>
      {video.thumbnail_url
        ? <img src={video.thumbnail_url} className="video-thumb" alt="" />
        : <div className="video-thumb-placeholder">▶</div>}
      <div className="video-info">
        <div className="video-name" title={video.original_name}>{video.original_name}</div>
        <div className="video-meta">
          <span className="video-duration">{formatDuration(video.duration)} · {formatBytes(video.file_size)}</span>
          <span className={`status-badge status-${video.status}`}>{video.status}</span>
        </div>
      </div>
      <button className="video-delete-btn" onClick={e => { e.stopPropagation(); onDelete(video.id) }}>✕</button>
    </div>
  )
}

function ProcessingStatus({ status }) {
  const pct = status.total_frames > 0 ? Math.round(status.processed_frames/status.total_frames*100) : 0
  if (status.status === 'completed') return null
  if (status.status === 'failed') return <div className="error-box">⚠ Processing failed: {status.error_message || 'Unknown error'}</div>
  return (
    <div className="processing-section">
      <div className="processing-header">
        <div className="processing-title">
          {status.status === 'processing' && <div className="processing-spinner" />}
          {status.status === 'pending' ? '⏳ Queued for processing' : '🔍 Analyzing frames…'}
        </div>
        <div className="processing-percent">{pct}%</div>
      </div>
      <div className="processing-bar-bg"><div className="processing-bar-fill" style={{width:`${pct}%`}} /></div>
      <div className="processing-sub">{status.processed_frames} / {status.total_frames} frames analyzed</div>
    </div>
  )
}

function PredictionResults({ data, duration }) {
  if (!data || data.predictions.length === 0) return (
    <div className="results-section">
      <div className="results-header"><div className="results-title">Analysis Results</div></div>
      <div className="no-videos">No predictions yet.</div>
    </div>
  )
  const { predictions, cat_present_count, cat_not_present_count, total_frames_analyzed } = data
  return (
    <div className="results-section">
      <div className="results-header">
        <div className="results-title">Frame Analysis · {total_frames_analyzed} frames</div>
        <div className="summary-pills">
          <span className="summary-pill pill-cat">🐱 Cat: {cat_present_count}</span>
          <span className="summary-pill pill-no-cat">∅ No cat: {cat_not_present_count}</span>
        </div>
      </div>
      <div className="timeline-wrap">
        <div className="timeline-label-row">Detection Timeline</div>
        <div className="timeline">
          {predictions.map(p => (
            <div key={p.id} className={`timeline-seg ${p.label==='cat_present'?'cat':'no-cat'}`}
              title={`${formatTimestamp(p.timestamp)} — ${p.label} (${p.confidence!=null?(p.confidence*100).toFixed(0)+'%':'N/A'})`} />
          ))}
        </div>
        <div className="timeline-labels"><span>0:00</span><span>{formatDuration(duration)}</span></div>
      </div>
      <div className="predictions-table-wrap">
        <table className="predictions-table">
          <thead><tr><th>Timestamp</th><th>Frame #</th><th>Label</th><th>Confidence</th></tr></thead>
          <tbody>
            {predictions.map(p => {
              const conf = p.confidence
              const confClass = conf==null?'':conf>=0.75?'high':conf>=0.5?'mid':'low'
              return (
                <tr key={p.id}>
                  <td><span className="timestamp-val">{formatTimestamp(p.timestamp)}</span></td>
                  <td><span className="timestamp-val">#{p.frame_number}</span></td>
                  <td><span className={`label-badge ${p.label==='cat_present'?'label-cat':'label-no-cat'}`}>{p.label==='cat_present'?'🐱 cat_present':'∅ cat_not_present'}</span></td>
                  <td>{conf!=null?(
                    <div className="confidence-bar-wrap">
                      <div className="confidence-bar"><div className={`confidence-fill ${confClass}`} style={{width:`${conf*100}%`}} /></div>
                      <span className="confidence-text">{(conf*100).toFixed(0)}%</span>
                    </div>
                  ):<span className="timestamp-val">—</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function VideoDetail({ videoId, onDeleted }) {
  const [video, setVideo] = useState(null)
  const [status, setStatus] = useState(null)
  const [predictions, setPredictions] = useState(null)
  const pollRef = useRef(null)

  const fetchAll = useCallback(async () => {
    try {
      const [vRes, sRes] = await Promise.all([fetch(`/api/videos/${videoId}`), fetch(`/api/videos/${videoId}/status`)])
      const v = await vRes.json(); const s = await sRes.json()
      setVideo(v); setStatus(s)
      if (s.status === 'completed') {
        const pRes = await fetch(`/api/videos/${videoId}/predictions`)
        setPredictions(await pRes.json())
      }
      return s.status
    } catch(e) { console.error(e) }
  }, [videoId])

  useEffect(() => {
    setPredictions(null); setVideo(null); setStatus(null)
    fetchAll().then(st => {
      if (st !== 'completed' && st !== 'failed') {
        pollRef.current = setInterval(async () => {
          const s = await fetchAll()
          if (s === 'completed' || s === 'failed') clearInterval(pollRef.current)
        }, 2500)
      }
    })
    return () => clearInterval(pollRef.current)
  }, [videoId, fetchAll])

  const handleDelete = async () => {
    if (!confirm('Delete this video?')) return
    await fetch(`/api/videos/${videoId}`, { method: 'DELETE' })
    onDeleted()
  }

  if (!video) return (
    <div className="video-detail">
      <div style={{display:'flex',justifyContent:'center',padding:'80px 0'}}>
        <div className="processing-spinner" style={{width:28,height:28,borderWidth:3}} />
      </div>
    </div>
  )

  return (
    <div className="video-detail">
      <div className="detail-header">
        <div>
          <div className="detail-title">{video.original_name}</div>
          <div className="detail-subtitle">Uploaded {new Date(video.created_at + 'Z').toLocaleString('en-IN')}</div>
        </div>
        <button className="btn btn-danger" onClick={handleDelete}>🗑 Delete</button>
      </div>
      <div className="video-player-section">
        <div className="video-player-wrap">
          <video controls src={`/uploads/${video.filename}`} />
        </div>
        <div className="video-stats-bar">
          <div className="stat-item"><span className="stat-label">Duration</span><span className="stat-value">{formatDuration(video.duration)}</span></div>
          <div className="stat-item"><span className="stat-label">Resolution</span><span className="stat-value">{video.width}×{video.height}</span></div>
          <div className="stat-item"><span className="stat-label">FPS</span><span className="stat-value">{video.fps?.toFixed(1)??'—'}</span></div>
          <div className="stat-item"><span className="stat-label">Size</span><span className="stat-value">{formatBytes(video.file_size)}</span></div>
        </div>
      </div>
      {status && <ProcessingStatus status={status} />}
      {predictions && <PredictionResults data={predictions} duration={video.duration} />}
    </div>
  )
}

export default function App() {
  const [videos, setVideos] = useState([])
  const [selectedId, setSelectedId] = useState(null)

  const fetchVideos = useCallback(async () => {
    try {
      const r = await fetch('/api/videos')
      setVideos(await r.json())
    } catch(e) { console.error(e) }
  }, [])

  useEffect(() => {
    fetchVideos()
    const iv = setInterval(fetchVideos, 5000)
    return () => clearInterval(iv)
  }, [fetchVideos])

  const handleUploaded = (video) => { fetchVideos(); setSelectedId(video.id) }
  const handleDelete = async (id) => {
    await fetch(`/api/videos/${id}`, { method: 'DELETE' })
    if (selectedId === id) setSelectedId(null)
    fetchVideos()
  }

  return (
    <div className="app">
      <nav className="navbar">
        <div className="navbar-logo"><div className="logo-dot" />Vision-Track</div>
        {/*<span className="navbar-badge">YOLO · Cat Detection</span>*/}
      </nav>
      <div className="main">
        <aside className="sidebar">
          <div className="sidebar-header">
            <div className="sidebar-title">Videos</div>
            <UploadZone onUploaded={handleUploaded} />
          </div>
          <div className="video-list">
            {videos.length === 0 && <div className="no-videos">No videos yet.<br/>Upload one above ↑</div>}
            {videos.map(v => (
              <VideoItem key={v.id} video={v} active={v.id===selectedId}
                onClick={() => setSelectedId(v.id)} onDelete={handleDelete} />
            ))}
          </div>
        </aside>
        <main className="content">
          {selectedId
            ? <VideoDetail key={selectedId} videoId={selectedId} onDeleted={() => { setSelectedId(null); fetchVideos() }} />
            : <div className="empty-state">
                <div className="empty-icon">🐱</div>
                <div className="empty-title">Select a video</div>
                <div className="empty-sub">Upload a video or pick one from the sidebar</div>
              </div>
          }
        </main>
      </div>
    </div>
  )
}
