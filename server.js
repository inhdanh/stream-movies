const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { scanMovies, deleteMedia } = require('./src/media');
const {
  transcodeToHls,
  getTranscodeStatus,
  cleanupStaleTranscodeOutputs,
  transcodeEvents
} = require('./src/transcoder');
const { saveProgress, getProgress } = require('./src/storage');
const { updateMovieMetadata } = require('./src/metadata');
const AutoTranscoder = require('./src/autoTranscoder');

const app = express();
const PORT = 3000;

// The base directory for movies and HLS output
const MOVIES_DIR = 'D:/Movies';
const HLS_OUTPUT_DIR = path.join(MOVIES_DIR, '.hls');
const CLIENT_DIST_DIR = path.join(__dirname, 'dist');
const COVER_IMAGE_NAME = 'cover.jpg';
const COVER_UPLOAD_LIMIT = '10mb';
const COVER_UPLOAD_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp']
]);

const autoTranscoder = new AutoTranscoder(MOVIES_DIR, HLS_OUTPUT_DIR);

function resolveMoviePath(filename) {
  const filePath = path.resolve(MOVIES_DIR, filename);
  const moviesRoot = path.resolve(MOVIES_DIR);

  if (filePath !== moviesRoot && !filePath.startsWith(`${moviesRoot}${path.sep}`)) {
    return null;
  }

  return filePath;
}

function resolveHlsPath(filename) {
  const hlsPath = path.resolve(HLS_OUTPUT_DIR, filename);
  const hlsRoot = path.resolve(HLS_OUTPUT_DIR);

  if (hlsPath !== hlsRoot && !hlsPath.startsWith(`${hlsRoot}${path.sep}`)) {
    return null;
  }

  return hlsPath;
}

function getCoverBasePath(filename) {
  const folder = path.dirname(filename).replace(/\\/g, '/');
  return folder && folder !== '.' ? folder : filename;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';

    proc.stderr.on('data', data => {
      stderr += data.toString();
    });

    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) {
        resolve();
        return;
      }

      const lastLines = stderr.trim().split(/\r?\n/).slice(-8).join('\n');
      reject(new Error(`ffmpeg exited with code ${code}${lastLines ? `: ${lastLines}` : ''}`));
    });
  });
}

async function saveCoverImage(filename, imageBuffer, mimeType) {
  const filePath = resolveMoviePath(filename);
  if (!filePath || !fs.existsSync(filePath)) {
    const error = new Error('Movie not found');
    error.statusCode = 404;
    throw error;
  }

  const normalizedMimeType = String(mimeType || '').split(';', 1)[0].trim().toLowerCase();
  const ext = COVER_UPLOAD_TYPES.get(normalizedMimeType);
  if (!ext) {
    const error = new Error('Cover must be a JPEG, PNG, or WebP image');
    error.statusCode = 415;
    throw error;
  }

  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    const error = new Error('Cover image is required');
    error.statusCode = 400;
    throw error;
  }

  const coverBasePath = getCoverBasePath(filename);
  const outputDir = resolveHlsPath(coverBasePath);
  if (!outputDir) {
    const error = new Error('Invalid movie path');
    error.statusCode = 400;
    throw error;
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const uploadId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempInput = path.join(outputDir, `.cover-upload-${uploadId}.input${ext}`);
  const tempOutput = path.join(outputDir, `.cover-upload-${uploadId}.output.jpg`);
  const coverPath = path.join(outputDir, COVER_IMAGE_NAME);

  try {
    fs.writeFileSync(tempInput, imageBuffer);
    await runFfmpeg([
      '-hide_banner',
      '-y',
      '-i', tempInput,
      '-frames:v', '1',
      '-vf', "scale='min(960,iw)':-2",
      '-q:v', '2',
      tempOutput
    ]);
    fs.renameSync(tempOutput, coverPath);
  } finally {
    fs.rmSync(tempInput, { force: true });
    fs.rmSync(tempOutput, { force: true });
  }

  return coverBasePath;
}

// Ensure HLS output directory exists
if (!fs.existsSync(HLS_OUTPUT_DIR)) {
  fs.mkdirSync(HLS_OUTPUT_DIR, { recursive: true });
}

cleanupStaleTranscodeOutputs(HLS_OUTPUT_DIR).catch(error => {
  console.warn(`[Server] Could not clean stale HLS staging outputs: ${error.message}`);
});

app.use(cors());
app.use(express.json());

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

// 2. Save display metadata. Movies inside a folder share series metadata.
app.put('/movies/:filename/metadata', (req, res) => {
  const filename = req.params.filename;
  const filePath = resolveMoviePath(filename);

  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Movie not found' });
  }

  try {
    const result = updateMovieMetadata(filename, req.body || {});
    res.json({
      success: true,
      scope: result.scope,
      key: result.key
    });
  } catch (error) {
    console.error('Error saving movie metadata:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to save movie metadata' });
  }
});

// 3. Start transcoding a movie to HLS
app.post('/movies/:filename/transcode', async (req, res) => {
  const filename = req.params.filename;
  const filePath = resolveMoviePath(filename);
  
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Movie not found' });
  }

  try {
    const jobId = await transcodeToHls(filePath, MOVIES_DIR, HLS_OUTPUT_DIR, {
      resolutions: req.body?.resolutions
    });
    res.json({ message: 'Transcoding started', jobId });
  } catch (error) {
    console.error('Error starting transcode:', error);
    res.status(500).json({ error: 'Failed to start transcoding', details: error.message });
  }
});

// 3b. Upload/replace movie cover image
app.post(
  '/movies/:filename/cover',
  express.raw({ type: Array.from(COVER_UPLOAD_TYPES.keys()), limit: COVER_UPLOAD_LIMIT }),
  async (req, res) => {
    const filename = req.params.filename;

    try {
      const coverBasePath = await saveCoverImage(filename, req.body, req.get('content-type'));
      res.json({
        success: true,
        coverBasePath,
        coverUrl: `/stream/${coverBasePath.split('/').map(encodeURIComponent).join('/')}/${COVER_IMAGE_NAME}`
      });
    } catch (error) {
      console.error('Error uploading cover:', error);
      res.status(error.statusCode || 500).json({ error: error.message || 'Failed to upload cover image' });
    }
  }
);

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
  const { seconds } = req.body;
  if (typeof seconds !== 'number') {
    return res.status(400).json({ error: 'Seconds must be a number' });
  }
  saveProgress(filename, seconds);
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

// Serve the React CMS build after API and streaming routes.
app.use(express.static(CLIENT_DIST_DIR));
app.get(/.*/, (req, res, next) => {
  const indexPath = path.join(CLIENT_DIST_DIR, 'index.html');
  if (!req.accepts('html') || !fs.existsSync(indexPath)) {
    return next();
  }
  res.sendFile(indexPath);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Network access: http://<YOUR_LAN_IP>:${PORT}`);
});
