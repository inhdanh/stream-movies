const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { scanMovies, getMediaInfo, deleteMedia } = require('./src/media');
const { transcodeToHls, getTranscodeStatus, transcodeEvents } = require('./src/transcoder');
const { saveProgress, getProgress } = require('./src/storage');
const AutoTranscoder = require('./src/autoTranscoder');

const app = express();
const PORT = 3000;

// The base directory for movies and HLS output
const MOVIES_DIR = 'D:/Movies';
const HLS_OUTPUT_DIR = path.join(MOVIES_DIR, '.hls');

const autoTranscoder = new AutoTranscoder(MOVIES_DIR, HLS_OUTPUT_DIR);

// Ensure HLS output directory exists
if (!fs.existsSync(HLS_OUTPUT_DIR)) {
  fs.mkdirSync(HLS_OUTPUT_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve the web UI

// 1. Get list of movies
app.get('/movies', async (req, res) => {
  try {
    const movies = await scanMovies(MOVIES_DIR, HLS_OUTPUT_DIR);
    res.json({ movies });
  } catch (error) {
    console.error('Error scanning movies:', error);
    res.status(500).json({ error: 'Failed to scan movies directory' });
  }
});

// 2. Get media info for a specific movie (Video, Audio, Subtitle streams)
app.get('/movies/:filename/info', async (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(MOVIES_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Movie not found' });
  }

  try {
    const info = await getMediaInfo(filePath);
    res.json(info);
  } catch (error) {
    console.error('Error getting media info:', error);
    res.status(500).json({ error: 'Failed to get media info' });
  }
});

// 3. Start transcoding a movie to HLS
app.post('/movies/:filename/transcode', async (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(MOVIES_DIR, filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Movie not found' });
  }

  try {
    const jobId = await transcodeToHls(filePath, MOVIES_DIR, HLS_OUTPUT_DIR);
    res.json({ message: 'Transcoding started', jobId });
  } catch (error) {
    console.error('Error starting transcode:', error);
    res.status(500).json({ error: 'Failed to start transcoding', details: error.message });
  }
});

// 4. Get transcode status
app.get('/movies/:filename/transcode/status', (req, res) => {
  const filename = req.params.filename;
  const status = getTranscodeStatus(filename, HLS_OUTPUT_DIR);
  res.json(status);
});

// 5. Get playback progress
app.get('/movies/:filename/progress', (req, res) => {
  const filename = req.params.filename;
  const progress = getProgress(filename);
  res.json(progress);
});

// 6. Save playback progress
app.post('/movies/:filename/progress', (req, res) => {
  const filename = req.params.filename;
  const { seconds, duration } = req.body;
  if (typeof seconds !== 'number') {
    return res.status(400).json({ error: 'Seconds must be a number' });
  }
  res.json({ success: true });
});

// 8. Delete movies (bulk)
app.delete('/movies', async (req, res) => {
  const { paths, deleteOriginal } = req.body;

  if (!paths || !Array.isArray(paths)) {
    return res.status(400).json({ error: 'Paths must be an array' });
  }

  try {
    for (const relPath of paths) {
      // Basic security check: prevent directory traversal
      const normalizedPath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
      await deleteMedia(normalizedPath, MOVIES_DIR, HLS_OUTPUT_DIR, { deleteOriginal });
    }
    res.json({ success: true, message: `Deleted ${paths.length} items` });
  } catch (error) {
    console.error('Error deleting movies:', error);
    res.status(500).json({ error: 'Failed to delete movies', details: error.message });
  }
});

// 7. Trigger auto-transcoding manually
app.post('/movies/auto-transcode', async (req, res) => {
  try {
    autoTranscoder.scan(); // Start a scan and process queue
    res.json({ message: 'Auto-transcoding scan started' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start auto-transcoding' });
  }
});

// 7. Trigger auto-transcoding manually

// 5. Serve static HLS files
// Example: /stream/movie.mkv/master.m3u8 -> serves D:/Movies/.hls/movie.mkv/master.m3u8
app.use('/stream', (req, res, next) => {
  // Add CORS headers specifically for HLS streaming if needed
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
}, express.static(HLS_OUTPUT_DIR));
 
 // SSE for real-time updates
 app.get('/events', (req, res) => {
   res.setHeader('Content-Type', 'text/event-stream');
   res.setHeader('Cache-Control', 'no-cache');
   res.setHeader('Connection', 'keep-alive');
   res.flushHeaders();
 
   const onProgress = (data) => {
     res.write(`event: progress\ndata: ${JSON.stringify(data)}\n\n`);
   };
 
   const onFinished = (data) => {
     res.write(`event: finished\ndata: ${JSON.stringify(data)}\n\n`);
   };
 
   transcodeEvents.on('progress', onProgress);
   transcodeEvents.on('finished', onFinished);
 
   req.on('close', () => {
     transcodeEvents.off('progress', onProgress);
     transcodeEvents.off('finished', onFinished);
   });
 });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Network access: http://<YOUR_LAN_IP>:${PORT}`);
});
