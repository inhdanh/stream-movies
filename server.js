const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { scanMovies, getMediaInfo } = require('./src/media');
const { transcodeToHls, getTranscodeStatus } = require('./src/transcoder');

const app = express();
const PORT = 3000;

// The base directory for movies and HLS output
const MOVIES_DIR = 'D:/Movies';
const HLS_OUTPUT_DIR = path.join(MOVIES_DIR, '.hls');

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
    const movies = await scanMovies(MOVIES_DIR);
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
  const status = getTranscodeStatus(filename);
  res.json(status);
});

// 5. Serve static HLS files
// Example: /stream/movie.mkv/master.m3u8 -> serves D:/Movies/.hls/movie.mkv/master.m3u8
app.use('/stream', (req, res, next) => {
  // Add CORS headers specifically for HLS streaming if needed
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
}, express.static(HLS_OUTPUT_DIR));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Network access: http://<YOUR_LAN_IP>:${PORT}`);
});
