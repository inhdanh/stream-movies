const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { getMediaInfo, scanMovies, deleteMedia } = require('./src/media');
const { saveProgress, getProgress } = require('./src/storage');
const { updateMovieMetadata } = require('./src/metadata');

const app = express();
const PORT = 3000;

// The base directory for movies and generated cover images.
const MOVIES_DIR = 'D:/Movies';
const COVERS_DIR = path.join(MOVIES_DIR, 'covers');
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

function resolveCoverPath(filename) {
  const coverPath = path.resolve(COVERS_DIR, filename);
  const coversRoot = path.resolve(COVERS_DIR);

  if (coverPath !== coversRoot && !coverPath.startsWith(`${coversRoot}${path.sep}`)) {
    return null;
  }

  return coverPath;
}

function getCoverBasePath(filename) {
  const folder = path.dirname(filename).replace(/\\/g, '/');
  return folder && folder !== '.' ? folder : filename;
}

function movieRecordExists(filename) {
  const filePath = resolveMoviePath(filename);
  return Boolean(filePath && fs.existsSync(filePath));
}

function getRouteFileParam(req) {
  const value = req.params.filename ?? req.params[0];
  if (Array.isArray(value)) {
    return value.join('/');
  }
  return value;
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

function getCompatibleMp4OutputPath(filePath) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}4khevcaac.mp4`);
}

function getFullMkvOutputPath(filePath) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}remuxfull.mkv`);
}

function getMediaUrl(relPath) {
  return `/media/${encodeURIComponent(relPath)}`;
}

function getCoverUrl(coverBasePath) {
  return `/covers/${coverBasePath.split('/').map(encodeURIComponent).join('/')}/${COVER_IMAGE_NAME}`;
}

function serializeMovie(movie) {
  const filePath = resolveMoviePath(movie.path);
  const fallbackPaths = filePath
    ? [getCompatibleMp4OutputPath(filePath), getFullMkvOutputPath(filePath)]
        .map(candidatePath => path.relative(MOVIES_DIR, candidatePath).replace(/\\/g, '/'))
    : [];
  const fallbackPath = fallbackPaths.find(candidatePath => {
    const candidateFilePath = resolveMoviePath(candidatePath);
    return candidateFilePath && fs.existsSync(candidateFilePath);
  });
  const fallbackLink = fallbackPath ? getMediaUrl(fallbackPath) : null;

  return {
    name: movie.name,
    path: movie.path,
    folder: movie.folder,
    displayName: movie.displayName,
    title: movie.title,
    metadataScope: movie.metadataScope,
    metadataKey: movie.metadataKey,
    episodeStart: movie.episodeStart,
    episodeNumber: movie.episodeNumber,
    durationSeconds: movie.durationSeconds,
    sourceWidth: movie.sourceWidth,
    sourceHeight: movie.sourceHeight,
    coverUrl: movie.coverBasePath ? getCoverUrl(movie.coverBasePath) : null,
    link: getMediaUrl(movie.path),
    fallbackLink
  };
}

function getAudioCompatibilityPlan(mediaInfo) {
  const audioStreams = mediaInfo.audio || [];
  const aacStream = audioStreams.find(stream => String(stream.codec).toLowerCase() === 'aac');
  if (aacStream) {
    return { stream: aacStream, codecArgs: ['-c:a', 'copy'], copied: true };
  }

  const dolbyStream = audioStreams.find(stream => ['eac3', 'ac3'].includes(String(stream.codec).toLowerCase()));
  if (dolbyStream) {
    return { stream: dolbyStream, codecArgs: ['-c:a', 'copy'], copied: true };
  }

  const fallbackStream = audioStreams[0];
  if (fallbackStream) {
    return { stream: fallbackStream, codecArgs: ['-c:a', 'aac', '-b:a', '192k'], copied: false };
  }

  return null;
}

async function createCompatibleMp4(filename) {
  const filePath = resolveMoviePath(filename);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    const error = new Error('Movie not found');
    error.statusCode = 404;
    throw error;
  }

  const outputPath = getCompatibleMp4OutputPath(filePath);
  if (path.resolve(filePath) === path.resolve(outputPath)) {
    const error = new Error('Source file is already the target MP4 path');
    error.statusCode = 400;
    throw error;
  }

  const outputRelPath = path.relative(MOVIES_DIR, outputPath).replace(/\\/g, '/');
  if (fs.existsSync(outputPath)) {
    return { alreadyExists: true, path: outputRelPath };
  }

  const mediaInfo = await getMediaInfo(filePath);
  if (!mediaInfo.video?.length) {
    const error = new Error('No video stream found');
    error.statusCode = 400;
    throw error;
  }

  const audioPlan = getAudioCompatibilityPlan(mediaInfo);
  const tempOutput = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.tmp-${Date.now()}.mp4`);
  const args = [
    '-hide_banner',
    '-y',
    '-i', filePath,
    '-map', '0:v:0'
  ];

  if (audioPlan) {
    args.push('-map', `0:${audioPlan.stream.index}`);
  }

  args.push(
    '-sn',
    '-dn',
    '-map_metadata', '0',
    '-c:v', 'copy',
    '-tag:v', 'hvc1',
    ...(audioPlan ? audioPlan.codecArgs : []),
    '-movflags', '+faststart',
    tempOutput
  );

  try {
    await runFfmpeg(args);
    fs.renameSync(tempOutput, outputPath);
  } finally {
    fs.rmSync(tempOutput, { force: true });
  }

  return {
    alreadyExists: false,
    audioCopied: Boolean(audioPlan?.copied),
    path: outputRelPath
  };
}

async function createFullMkvRemux(filename) {
  const filePath = resolveMoviePath(filename);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    const error = new Error('Movie not found');
    error.statusCode = 404;
    throw error;
  }

  const outputPath = getFullMkvOutputPath(filePath);
  if (path.resolve(filePath) === path.resolve(outputPath)) {
    const error = new Error('Source file is already the target MKV path');
    error.statusCode = 400;
    throw error;
  }

  const outputRelPath = path.relative(MOVIES_DIR, outputPath).replace(/\\/g, '/');
  if (fs.existsSync(outputPath)) {
    return { alreadyExists: true, path: outputRelPath };
  }

  const tempOutput = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.tmp-${Date.now()}.mkv`);

  try {
    await runFfmpeg([
      '-hide_banner',
      '-y',
      '-i', filePath,
      '-map', '0',
      '-map_metadata', '0',
      '-map_chapters', '0',
      '-c', 'copy',
      tempOutput
    ]);
    fs.renameSync(tempOutput, outputPath);
  } finally {
    fs.rmSync(tempOutput, { force: true });
  }

  return {
    alreadyExists: false,
    path: outputRelPath
  };
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
  const outputDir = resolveCoverPath(coverBasePath);
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

async function generateCoverImage(filename) {
  if (!movieRecordExists(filename)) {
    const error = new Error('Movie not found');
    error.statusCode = 404;
    throw error;
  }

  const filePath = resolveMoviePath(filename);
  const inputPath = filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? filePath
    : null;

  if (!inputPath) {
    const error = new Error('Movie source not found');
    error.statusCode = 404;
    throw error;
  }

  const coverBasePath = getCoverBasePath(filename);
  const outputDir = resolveCoverPath(coverBasePath);
  if (!outputDir) {
    const error = new Error('Invalid movie path');
    error.statusCode = 400;
    throw error;
  }

  fs.mkdirSync(outputDir, { recursive: true });

  let seekSeconds = 60;
  try {
    const info = await getMediaInfo(inputPath);
    const duration = Number(info?.duration);
    if (Number.isFinite(duration) && duration > 0) {
      seekSeconds = duration > 16
        ? Math.max(8, Math.min(duration * 0.2, duration - 8))
        : Math.max(0, duration / 2);
    }
  } catch (error) {
    console.warn(`[Cover] Failed to read duration for ${filename}: ${error.message}`);
  }

  const generationId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempOutput = path.join(outputDir, `.cover-generate-${generationId}.jpg`);
  const coverPath = path.join(outputDir, COVER_IMAGE_NAME);
  const buildFfmpegArgs = seconds => [
    '-hide_banner',
    '-y',
    ...(seconds > 0 ? ['-ss', String(seconds)] : []),
    '-i', inputPath,
    '-map', '0:v:0',
    '-frames:v', '1',
    '-vf', "scale='min(1280,iw)':-2",
    '-q:v', '2',
    tempOutput
  ];

  try {
    try {
      await runFfmpeg(buildFfmpegArgs(seekSeconds));
    } catch (error) {
      if (seekSeconds <= 0) throw error;
      fs.rmSync(tempOutput, { force: true });
      await runFfmpeg(buildFfmpegArgs(0));
    }
    fs.renameSync(tempOutput, coverPath);
  } finally {
    fs.rmSync(tempOutput, { force: true });
  }

  return coverBasePath;
}

// Ensure generated asset directories exist
if (!fs.existsSync(COVERS_DIR)) {
  fs.mkdirSync(COVERS_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());

// 1. Get list of movies
app.get('/movies', async (req, res) => {
  try {
    const movies = await scanMovies(MOVIES_DIR, '', { coversDir: COVERS_DIR });
    res.json({ movies: movies.map(serializeMovie) });
  } catch (error) {
    console.error('Error scanning movies:', error);
    res.status(500).json({ error: 'Failed to scan movies directory' });
  }
});

// 2. Save display metadata. Movies inside a folder share series metadata.
app.put(/^\/movies\/(.+)\/metadata$/, (req, res) => {
  const filename = getRouteFileParam(req);

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

// 3. Create a high-quality MP4 fallback by remuxing the original video stream.
app.post(/^\/movies\/(.+)\/compatible-mp4$/, async (req, res) => {
  const filename = getRouteFileParam(req);

  try {
    const result = await createCompatibleMp4(filename);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error creating compatible MP4:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to create compatible MP4' });
  }
});

// 3a. Create a full MKV remux that preserves video, audio, subtitles, chapters, and metadata.
app.post(/^\/movies\/(.+)\/full-mkv$/, async (req, res) => {
  const filename = getRouteFileParam(req);

  try {
    const result = await createFullMkvRemux(filename);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error creating full MKV remux:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to create full MKV remux' });
  }
});

// 3b. Upload/replace movie cover image
app.post(
  /^\/movies\/(.+)\/cover$/,
  express.raw({ type: Array.from(COVER_UPLOAD_TYPES.keys()), limit: COVER_UPLOAD_LIMIT }),
  async (req, res) => {
    const filename = getRouteFileParam(req);

    try {
      const coverBasePath = await saveCoverImage(filename, req.body, req.get('content-type'));
      res.json({
        success: true,
        coverUrl: getCoverUrl(coverBasePath)
      });
    } catch (error) {
      console.error('Error uploading cover:', error);
      res.status(error.statusCode || 500).json({ error: error.message || 'Failed to upload cover image' });
    }
  }
);

// 3c. Generate/replace movie cover image from the current movie source.
app.post(/^\/movies\/(.+)\/cover\/generate$/, async (req, res) => {
  const filename = getRouteFileParam(req);

  try {
    const coverBasePath = await generateCoverImage(filename);
    res.json({
      success: true,
      coverUrl: getCoverUrl(coverBasePath)
    });
  } catch (error) {
    console.error('Error generating cover:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to generate cover image' });
  }
});

// 5. Get playback progress
app.get(/^\/movies\/(.+)\/progress$/, (req, res) => {
  const filename = getRouteFileParam(req);
  const progress = getProgress(filename);
  res.json(progress);
});

// 6. Save playback progress
app.post(/^\/movies\/(.+)\/progress$/, (req, res) => {
  const filename = getRouteFileParam(req);
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
      await deleteMedia(normalizedPath, MOVIES_DIR, { coversDir: COVERS_DIR, deleteOriginal });
    }
    res.json({ success: true, message: `Deleted ${paths.length} items` });
  } catch (error) {
    console.error('Error deleting movies:', error);
    res.status(500).json({ error: 'Failed to delete movies', details: error.message });
  }
});

// 5. Serve generated cover images.
app.use('/covers', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
}, express.static(COVERS_DIR));

// 6. Serve original movie files directly with byte-range support.
app.route(/^\/media\/(.+)$/)
  .get((req, res) => {
    const filePath = resolveMoviePath(getRouteFileParam(req));
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return res.status(404).json({ error: 'Movie not found' });
    }
    return sendMediaFile(req, res, filePath);
  })
  .head((req, res) => {
    const filePath = resolveMoviePath(getRouteFileParam(req));
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
