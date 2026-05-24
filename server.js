const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { scanMovies, deleteMedia } = require('./src/media');
const { saveProgress, getProgress } = require('./src/storage');
const { updateMovieMetadata } = require('./src/metadata');

const app = express();
const PORT = 3000;

// The base directory for movies and generated assets such as cover images.
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

const VIDEO_CONTENT_TYPES = new Map([
  ['.mkv', 'video/x-matroska'],
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.avi', 'video/x-msvideo'],
  ['.wmv', 'video/x-ms-wmv']
]);

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

function movieRecordExists(filename) {
  const filePath = resolveMoviePath(filename);
  if (filePath && fs.existsSync(filePath)) return true;

  const hlsPath = resolveHlsPath(filename);
  return Boolean(hlsPath && fs.existsSync(path.join(hlsPath, 'master.m3u8')));
}

function getVideoContentType(filePath) {
  return VIDEO_CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

function parseRangeHeader(rangeHeader, fileSize) {
  if (!rangeHeader) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) return 'invalid';

  let start = match[1] ? Number.parseInt(match[1], 10) : null;
  let end = match[2] ? Number.parseInt(match[2], 10) : null;

  if (start === null && end === null) return 'invalid';
  if (start === null) {
    const suffixLength = end;
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'invalid';
    start = Math.max(fileSize - suffixLength, 0);
    end = fileSize - 1;
  } else {
    if (!Number.isFinite(start) || start < 0) return 'invalid';
    if (end === null || end >= fileSize) end = fileSize - 1;
  }

  if (!Number.isFinite(end) || start > end || start >= fileSize) return 'invalid';
  return { start, end };
}

function sendMediaFile(req, res, filePath) {
  const stats = fs.statSync(filePath);
  const fileSize = stats.size;
  const contentType = getVideoContentType(filePath);
  const range = parseRangeHeader(req.headers.range, fileSize);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=0');

  if (range === 'invalid') {
    res.setHeader('Content-Range', `bytes */${fileSize}`);
    return res.status(416).end();
  }

  if (range) {
    const { start, end } = range;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  res.setHeader('Content-Length', fileSize);
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(filePath).pipe(res);
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
  if (!movieRecordExists(filename)) {
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

// Ensure generated asset directory exists
if (!fs.existsSync(HLS_OUTPUT_DIR)) {
  fs.mkdirSync(HLS_OUTPUT_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());

// 1. Get list of movies
app.get('/movies', async (req, res) => {
  try {
    const movies = await scanMovies(MOVIES_DIR, HLS_OUTPUT_DIR, '', { includeHlsOnly: false });
    res.json({ movies });
  } catch (error) {
    console.error('Error scanning movies:', error);
    res.status(500).json({ error: 'Failed to scan movies directory' });
  }
});

// 2. Save display metadata. Movies inside a folder share series metadata.
app.put('/movies/:filename/metadata', (req, res) => {
  const filename = req.params.filename;

  if (!movieRecordExists(filename)) {
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

// 5. Serve generated assets such as cover images.
app.use('/stream', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
}, express.static(HLS_OUTPUT_DIR));

// 6. Serve original movie files directly with byte-range support.
app.route('/media/:filename')
  .get((req, res) => {
    const filePath = resolveMoviePath(req.params.filename);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return res.status(404).json({ error: 'Movie not found' });
    }
    return sendMediaFile(req, res, filePath);
  })
  .head((req, res) => {
    const filePath = resolveMoviePath(req.params.filename);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return res.status(404).end();
    }
    return sendMediaFile(req, res, filePath);
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
