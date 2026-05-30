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
const AUTO_COVER_ENABLED = process.env.AUTO_COVER_ENABLED !== 'false';
const AUTO_COVER_RETRY_MS = 15 * 60 * 1000;
const VIDEO_CONTENT_TYPES = new Map([
  ['.mkv', 'video/x-matroska'],
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.avi', 'video/x-msvideo'],
  ['.wmv', 'video/x-ms-wmv']
]);

const autoCoverJobs = new Map();
let autoCoverQueue = Promise.resolve();
const aacTranscodeJobs = new Map();
let aacTranscodeQueue = Promise.resolve();

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

function runFfmpeg(args, onStderr) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';

    proc.stderr.on('data', data => {
      const text = data.toString();
      stderr += text;
      if (onStderr) onStderr(text);
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

function getAacTranscodeOutputPath(filePath) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}AAC${parsed.ext}`);
}

function getMediaUrl(relPath) {
  return `/media/${encodeURIComponent(relPath)}`;
}

function getCoverUrl(coverBasePath) {
  return `/covers/${coverBasePath.split('/').map(encodeURIComponent).join('/')}/${COVER_IMAGE_NAME}`;
}

function getAutoCoverStatus(coverBasePath) {
  if (!coverBasePath) return null;
  const job = autoCoverJobs.get(coverBasePath);
  if (!job) return null;
  return {
    status: job.status,
    error: job.error || null,
    updatedAt: job.updatedAt
  };
}

function getAutoAacTranscodeStatus(filename) {
  const job = aacTranscodeJobs.get(filename);
  if (!job) return null;
  return {
    status: job.status,
    error: job.error || null,
    progress: job.progress || 0,
    timeSeconds: job.timeSeconds || 0,
    durationSeconds: job.durationSeconds || null,
    outputPath: job.outputPath || null,
    updatedAt: job.updatedAt
  };
}

function serializeMovie(movie) {
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
    coverGenerating: ['queued', 'running'].includes(movie.autoCoverStatus?.status),
    coverGenerationError: movie.autoCoverStatus?.status === 'failed'
      ? movie.autoCoverStatus.error
      : null,
    audioTranscoding: ['queued', 'running'].includes(movie.autoAacTranscodeStatus?.status),
    audioTranscodeError: movie.autoAacTranscodeStatus?.status === 'failed'
      ? movie.autoAacTranscodeStatus.error
      : null,
    audioTranscodeProgress: movie.autoAacTranscodeStatus?.progress || 0,
    audioTranscodedPath: movie.autoAacTranscodeStatus?.outputPath || null,
    link: getMediaUrl(movie.path)
  };
}

function needsAacAudioTranscode(mediaInfo) {
  const audioStreams = mediaInfo.audio || [];
  if (!audioStreams.length) return false;

  return audioStreams.some(stream => String(stream.codec || '').toLowerCase() !== 'aac');
}

function parseFfmpegTimeSeconds(text) {
  const matches = Array.from(String(text || '').matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g));
  const match = matches.at(-1);
  if (!match) return null;

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseFloat(match[3]);
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;

  return hours * 3600 + minutes * 60 + seconds;
}

function updateAacTranscodeJob(filename, patch) {
  const existingJob = aacTranscodeJobs.get(filename);
  if (!existingJob) return;

  aacTranscodeJobs.set(filename, {
    ...existingJob,
    ...patch,
    updatedAt: Date.now()
  });
}

async function transcodeAudioToAac(filename, onProgress) {
  const filePath = resolveMoviePath(filename);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    const error = new Error('Movie not found');
    error.statusCode = 404;
    throw error;
  }

  const mediaInfo = await getMediaInfo(filePath);
  if (!mediaInfo.video?.length) {
    const error = new Error('No video stream found');
    error.statusCode = 400;
    throw error;
  }

  if (!needsAacAudioTranscode(mediaInfo)) {
    return {
      skipped: true,
      reason: 'Audio is already AAC',
      path: filename
    };
  }

  const durationSeconds = Number(mediaInfo.duration);
  if (Number.isFinite(durationSeconds) && durationSeconds > 0 && onProgress) {
    onProgress({ durationSeconds, progress: 0, timeSeconds: 0 });
  }

  const outputPath = getAacTranscodeOutputPath(filePath);
  if (path.resolve(filePath) === path.resolve(outputPath)) {
    const error = new Error('Source file is already the target AAC path');
    error.statusCode = 400;
    throw error;
  }

  const outputRelPath = path.relative(MOVIES_DIR, outputPath).replace(/\\/g, '/');
  if (fs.existsSync(outputPath)) {
    const outputMediaInfo = await getMediaInfo(outputPath);
    if (!outputMediaInfo.video?.length || !outputMediaInfo.audio?.length || needsAacAudioTranscode(outputMediaInfo)) {
      const error = new Error(`AAC target already exists but is not a valid AAC video: ${outputRelPath}`);
      error.statusCode = 409;
      throw error;
    }

    fs.unlinkSync(filePath);
    return {
      alreadyExists: true,
      skipped: false,
      path: outputRelPath
    };
  }

  const transcodeId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const parsedOutput = path.parse(outputPath);
  const tempOutput = path.join(parsedOutput.dir, `.${parsedOutput.name}.tmp-${transcodeId}${parsedOutput.ext}`);

  try {
    await runFfmpeg([
      '-hide_banner',
      '-y',
      '-i', filePath,
      '-map', '0',
      '-map_metadata', '0',
      '-map_chapters', '0',
      '-c', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',
      tempOutput
    ], text => {
      if (!onProgress) return;

      const timeSeconds = parseFfmpegTimeSeconds(text);
      if (timeSeconds === null) return;

      const progress = Number.isFinite(durationSeconds) && durationSeconds > 0
        ? Math.min(99, Math.max(0, Math.round((timeSeconds / durationSeconds) * 100)))
        : 0;
      onProgress({ durationSeconds, progress, timeSeconds });
    });
    fs.renameSync(tempOutput, outputPath);
    fs.unlinkSync(filePath);
  } finally {
    fs.rmSync(tempOutput, { force: true });
  }

  return {
    skipped: false,
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

function hasCoverImage(coverBasePath) {
  const outputDir = resolveCoverPath(coverBasePath);
  return Boolean(outputDir && fs.existsSync(path.join(outputDir, COVER_IMAGE_NAME)));
}

function queueAutoCoverGeneration(filename) {
  const coverBasePath = getCoverBasePath(filename);
  if (!coverBasePath || hasCoverImage(coverBasePath)) {
    return false;
  }

  const existingJob = autoCoverJobs.get(coverBasePath);
  const now = Date.now();
  if (existingJob) {
    if (['queued', 'running'].includes(existingJob.status)) return false;
    if (existingJob.status === 'failed' && now - existingJob.updatedAt < AUTO_COVER_RETRY_MS) {
      return false;
    }
  }

  autoCoverJobs.set(coverBasePath, {
    error: null,
    filename,
    status: 'queued',
    updatedAt: now
  });

  autoCoverQueue = autoCoverQueue
    .catch(() => undefined)
    .then(async () => {
      const runningJob = autoCoverJobs.get(coverBasePath);
      if (!runningJob || hasCoverImage(coverBasePath)) {
        return;
      }

      autoCoverJobs.set(coverBasePath, {
        ...runningJob,
        status: 'running',
        updatedAt: Date.now()
      });

      try {
        await generateCoverImage(filename);
        autoCoverJobs.set(coverBasePath, {
          ...runningJob,
          error: null,
          status: 'done',
          updatedAt: Date.now()
        });
        console.log(`[Cover] Auto-generated cover for ${filename}`);
      } catch (error) {
        autoCoverJobs.set(coverBasePath, {
          ...runningJob,
          error: error.message || 'Failed to generate cover',
          status: 'failed',
          updatedAt: Date.now()
        });
        console.warn(`[Cover] Auto-cover failed for ${filename}: ${error.message}`);
      }
    });

  return true;
}

function queueMissingCoverImages(movies) {
  if (!AUTO_COVER_ENABLED) {
    return { enabled: false, queued: 0, active: 0 };
  }

  let queued = 0;
  const seenCoverBasePaths = new Set();

  for (const movie of movies) {
    if (movie.coverBasePath || !movie.path) continue;

    const coverBasePath = getCoverBasePath(movie.path);
    if (seenCoverBasePaths.has(coverBasePath)) continue;
    seenCoverBasePaths.add(coverBasePath);

    if (queueAutoCoverGeneration(movie.path)) {
      queued++;
    }
  }

  const active = Array.from(autoCoverJobs.values())
    .filter(job => ['queued', 'running'].includes(job.status))
    .length;

  return { enabled: true, queued, active };
}

function withAutoCoverStatus(movie) {
  const coverBasePath = movie.coverBasePath || getCoverBasePath(movie.path);
  return {
    ...movie,
    autoCoverStatus: getAutoCoverStatus(coverBasePath)
  };
}

function startAacTranscodeJob(filename) {
  const filePath = resolveMoviePath(filename);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    const error = new Error('Movie not found');
    error.statusCode = 404;
    throw error;
  }

  const existingJob = aacTranscodeJobs.get(filename);
  const now = Date.now();
  if (existingJob) {
    if (['queued', 'running'].includes(existingJob.status)) {
      return getAutoAacTranscodeStatus(filename);
    }
  }

  aacTranscodeJobs.set(filename, {
    durationSeconds: null,
    error: null,
    filename,
    outputPath: null,
    progress: 0,
    status: 'queued',
    timeSeconds: 0,
    updatedAt: now
  });

  aacTranscodeQueue = aacTranscodeQueue
    .catch(() => undefined)
    .then(async () => {
      const runningJob = aacTranscodeJobs.get(filename);
      if (!runningJob) return;

      updateAacTranscodeJob(filename, {
        status: 'running',
        progress: 0,
        timeSeconds: 0
      });

      try {
        const result = await transcodeAudioToAac(filename, progress => {
          updateAacTranscodeJob(filename, progress);
        });
        updateAacTranscodeJob(filename, {
          error: null,
          outputPath: result.path,
          progress: 100,
          status: result.skipped ? 'skipped' : 'done',
          timeSeconds: aacTranscodeJobs.get(filename)?.durationSeconds || aacTranscodeJobs.get(filename)?.timeSeconds || 0
        });

        if (result.skipped) {
          console.log(`[Audio] Skipped AAC transcode for ${filename}: ${result.reason}`);
        } else if (result.alreadyExists) {
          console.log(`[Audio] Removed source because AAC target already exists: ${filename} -> ${result.path}`);
        } else {
          console.log(`[Audio] Transcoded audio to AAC: ${filename} -> ${result.path}`);
        }
      } catch (error) {
        updateAacTranscodeJob(filename, {
          error: error.message || 'Failed to transcode audio to AAC',
          outputPath: null,
          status: 'failed'
        });
        console.warn(`[Audio] AAC transcode failed for ${filename}: ${error.message}`);
      }
    });

  return getAutoAacTranscodeStatus(filename);
}

function withAutoAacTranscodeStatus(movie) {
  return {
    ...movie,
    autoAacTranscodeStatus: getAutoAacTranscodeStatus(movie.path)
  };
}

async function loadMoviesFromDisk() {
  return scanMovies(MOVIES_DIR, '', { coversDir: COVERS_DIR });
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
    res.setHeader('Cache-Control', 'no-store');
    const movies = await loadMoviesFromDisk();
    const autoCover = queueMissingCoverImages(movies);
    res.json({
      movies: movies.map(movie => serializeMovie(withAutoAacTranscodeStatus(withAutoCoverStatus(movie)))),
      autoCover
    });
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

// 3. Transcode all audio streams to AAC while preserving video, subtitles, chapters, and metadata.
app.post(/^\/movies\/(.+)\/aac-transcode$/, async (req, res) => {
  const filename = getRouteFileParam(req);

  try {
    const job = startAacTranscodeJob(filename);
    res.status(job.status === 'queued' ? 202 : 200).json({ success: true, job });
  } catch (error) {
    console.error('Error starting AAC transcode:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to start AAC transcode' });
  }
});

// 3a. Read AAC transcode job status/progress for a movie.
app.get(/^\/movies\/(.+)\/aac-transcode$/, (req, res) => {
  const filename = getRouteFileParam(req);
  const job = getAutoAacTranscodeStatus(filename);

  if (!job) {
    return res.json({
      status: 'idle',
      error: null,
      progress: 0,
      timeSeconds: 0,
      durationSeconds: null,
      outputPath: null,
      updatedAt: null
    });
  }

  return res.json(job);
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
