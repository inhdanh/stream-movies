const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const { getMediaInfo } = require('./media');

const HLS_SEGMENT_SECONDS = 6;
const HLS_PLAYLIST_VERSION = 7;
const AUDIO_BITRATE = '160k';
const AUDIO_GROUP_ID = 'audio';
const SUBTITLE_GROUP_ID = 'subs';
const COVER_IMAGE_NAME = 'cover.jpg';
const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'srt', 'webvtt']);
const WINDOWS_RETRYABLE_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

const VIDEO_LADDER = [
  {
    name: '2160p',
    width: 3840,
    height: 2160,
    bitrate: '12000k',
    averageBandwidth: 10000000,
    maxrate: '14000k',
    bufsize: '24000k',
    profile: 'high',
    level: '5.1',
    codecs: 'avc1.640033'
  },
  {
    name: '1080p',
    width: 1920,
    height: 1080,
    bitrate: '5800k',
    averageBandwidth: 5000000,
    maxrate: '6500k',
    bufsize: '11600k',
    profile: 'high',
    level: '4.1',
    codecs: 'avc1.640029'
  },
  {
    name: '720p',
    width: 1280,
    height: 720,
    bitrate: '3000k',
    averageBandwidth: 2800000,
    maxrate: '3600k',
    bufsize: '6000k',
    profile: 'high',
    level: '3.1',
    codecs: 'avc1.64001f'
  },
  {
    name: '480p',
    width: 854,
    height: 480,
    bitrate: '1400k',
    averageBandwidth: 1200000,
    maxrate: '1800k',
    bufsize: '2800k',
    profile: 'main',
    level: '3.0',
    codecs: 'avc1.4d401e'
  },
  {
    name: '360p',
    width: 640,
    height: 360,
    bitrate: '800k',
    averageBandwidth: 700000,
    maxrate: '1000k',
    bufsize: '1600k',
    profile: 'main',
    level: '3.0',
    codecs: 'avc1.4d401e'
  }
];

const transcodeEvents = new EventEmitter();
const transcodeJobs = new Map();

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toPosixPath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function cleanTagValue(value, fallback) {
  const text = String(value || fallback || '').trim();
  return text.replace(/["\r\n]/g, '');
}

function safeId(value, fallback) {
  const id = String(value || fallback || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return id || fallback;
}

function isTextSubtitle(codec) {
  return TEXT_SUBTITLE_CODECS.has(codec);
}

function parseFfmpegTime(text) {
  const match = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseFloat(match[3]);
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

function parseFrameRate(value) {
  if (!value || value === '0/0') return 30;

  const [numerator, denominator] = String(value).split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  }

  return numerator / denominator;
}

function formatFrameRate(value) {
  const frameRate = parseFrameRate(value);
  return frameRate.toFixed(3).replace(/\.?0+$/, '');
}

function even(value) {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function bitrateToBits(value) {
  const match = String(value).match(/^(\d+(?:\.\d+)?)([kKmM]?)$/);
  if (!match) return 0;

  const amount = Number.parseFloat(match[1]);
  const suffix = match[2].toLowerCase();
  if (suffix === 'm') return Math.round(amount * 1000000);
  if (suffix === 'k') return Math.round(amount * 1000);
  return Math.round(amount);
}

function createJob(filename) {
  const job = {
    id: Date.now().toString(),
    status: 'processing',
    progress: 0,
    promise: null
  };

  transcodeJobs.set(filename, job);
  transcodeEvents.emit('progress', { filename, progress: 0 });
  return job;
}

function updateJob(filename, patch) {
  const current = transcodeJobs.get(filename) || {};
  const next = { ...current, ...patch };
  transcodeJobs.set(filename, next);
  return next;
}

function getDefaultAudioIndex(audioStreams) {
  const explicitDefault = audioStreams.findIndex(audio => audio.isDefault);
  return explicitDefault >= 0 ? explicitDefault : 0;
}

function getTargetWidth(sourceWidth, sourceHeight, targetHeight, maxWidth) {
  if (!sourceWidth || !sourceHeight) return maxWidth;
  return even(Math.min(maxWidth, sourceWidth * (targetHeight / sourceHeight)));
}

function buildVideoRenditions(video) {
  const sourceWidth = even(video.width || 1920);
  const sourceHeight = even(video.height || 1080);
  const frameRate = formatFrameRate(video.frameRate);

  if (sourceHeight < 720) {
    const name = `${sourceHeight}p`;
    const averageBandwidth = Math.min(1200000, Math.max(600000, sourceWidth * sourceHeight * 3));

    return [{
      name,
      width: sourceWidth,
      height: sourceHeight,
      bitrate: `${Math.ceil(averageBandwidth / 1000)}k`,
      averageBandwidth,
      maxrate: `${Math.ceil(averageBandwidth * 1.25 / 1000)}k`,
      bufsize: `${Math.ceil(averageBandwidth * 2 / 1000)}k`,
      profile: 'main',
      level: '3.0',
      codecs: 'avc1.4d401e',
      frameRate,
      playlist: `video/${name}/prog_index.m3u8`
    }];
  }

  return VIDEO_LADDER
    .filter(profile => profile.height <= sourceHeight)
    .map(profile => ({
      ...profile,
      width: getTargetWidth(sourceWidth, sourceHeight, profile.height, profile.width),
      frameRate,
      playlist: `video/${profile.name}/prog_index.m3u8`
    }));
}

function buildRenditions(info, outputDir) {
  const video = info.video[0];
  if (!video) {
    throw new Error('No video stream found');
  }

  const videoRenditions = buildVideoRenditions(video);
  videoRenditions.forEach(rendition => {
    ensureDir(path.join(outputDir, 'video', rendition.name));
  });

  const defaultAudioIndex = getDefaultAudioIndex(info.audio);
  const audio = info.audio.map((stream, index) => {
    const language = safeId(stream.languageCode, `aud${index}`);
    const id = `${language}_${index}`;
    const playlist = `audio/${id}/prog_index.m3u8`;
    ensureDir(path.join(outputDir, 'audio', id));

    return {
      inputIndex: stream.index,
      outputIndex: index,
      language,
      id,
      name: cleanTagValue(stream.title || stream.language, language),
      channels: stream.channels || 2,
      isDefault: index === defaultAudioIndex,
      playlist
    };
  });

  const subtitles = info.subtitle
    .filter(stream => isTextSubtitle(stream.codec))
    .map((stream, index) => {
      const language = safeId(stream.languageCode, `sub${index}`);
      const id = `${language}_${index}`;
      const playlist = `subtitles/${id}/sub.m3u8`;
      const fileName = 'sub.vtt';
      const dir = path.join(outputDir, 'subtitles', id);
      ensureDir(dir);

      return {
        inputIndex: stream.index,
        language,
        id,
        name: cleanTagValue(stream.title || stream.language, language),
        isDefault: Boolean(stream.isDefault),
        isForced: Boolean(stream.isForced),
        playlist,
        fileName,
        filePath: path.join(dir, fileName)
      };
    });

  return {
    sourceVideoIndex: video.index,
    video: videoRenditions,
    audio,
    subtitles
  };
}

function getGopSize(info) {
  const frameRate = parseFrameRate(info.video[0]?.frameRate);
  return Math.max(24, Math.round(frameRate * HLS_SEGMENT_SECONDS));
}

function buildStreamMap(renditions) {
  const streamMap = [];

  renditions.video.forEach((video, index) => {
    streamMap.push(`v:${index},name:video/${video.name}`);
  });

  renditions.audio.forEach(audio => {
    const parts = [
      `a:${audio.outputIndex}`,
      `name:audio/${audio.id}`,
      `agroup:${AUDIO_GROUP_ID}`,
      `language:${audio.language}`
    ];

    if (audio.isDefault) {
      parts.push('default:yes');
    }

    streamMap.push(parts.join(','));
  });

  return streamMap.join(' ');
}

function buildMediaArgs(filePath, outputDir, info, renditions) {
  const gopSize = getGopSize(info);
  const args = [
    '-hide_banner',
    '-y',
    '-fflags', '+genpts',
    '-i', filePath,
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-max_muxing_queue_size', '9999'
  ];

  renditions.video.forEach((video, index) => {
    args.push(
      '-map', `0:${renditions.sourceVideoIndex}`,
      `-c:v:${index}`, 'libx264',
      `-filter:v:${index}`, `scale=${video.width}:${video.height}:flags=lanczos`,
      `-b:v:${index}`, video.bitrate,
      `-maxrate:v:${index}`, video.maxrate,
      `-bufsize:v:${index}`, video.bufsize,
      `-profile:v:${index}`, video.profile,
      `-level:v:${index}`, video.level,
      `-g:v:${index}`, String(gopSize),
      `-keyint_min:v:${index}`, String(gopSize),
      `-sc_threshold:v:${index}`, '0'
    );
  });

  args.push(
    '-preset', 'medium',
    '-pix_fmt', 'yuv420p',
    '-force_key_frames', `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`
  );

  renditions.audio.forEach(audio => {
    args.push(
      '-map', `0:${audio.inputIndex}`,
      `-c:a:${audio.outputIndex}`, 'aac',
      `-b:a:${audio.outputIndex}`, AUDIO_BITRATE,
      `-ac:a:${audio.outputIndex}`, '2'
    );
  });

  args.push(
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_SECONDS),
    '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', toPosixPath(path.join(outputDir, '%v', 'seg_%05d.m4s')),
    '-var_stream_map', buildStreamMap(renditions),
    toPosixPath(path.join(outputDir, '%v', 'prog_index.m3u8'))
  );

  return args;
}

function runFfmpeg(args, onStderr) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';

    proc.stderr.on('data', data => {
      const text = data.toString();
      stderr += text;
      onStderr?.(text);
    });

    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) {
        resolve();
        return;
      }

      const lastLines = stderr.trim().split(/\r?\n/).slice(-10).join('\n');
      reject(new Error(`ffmpeg exited with code ${code}${lastLines ? `: ${lastLines}` : ''}`));
    });
  });
}

async function extractSubtitle(filePath, subtitle, durationSeconds) {
  const args = [
    '-hide_banner',
    '-y',
    '-i', filePath,
    '-map', `0:${subtitle.inputIndex}`,
    '-c:s', 'webvtt',
    subtitle.filePath
  ];

  try {
    await runFfmpeg(args);
    writeSubtitlePlaylist(subtitle, durationSeconds);
    return true;
  } catch (error) {
    console.error(`[Transcode] Subtitle ${subtitle.language} skipped: ${error.message}`);
    return false;
  }
}

async function extractCoverImage(filePath, outputDir, info, renditions) {
  const durationSeconds = Number(info.duration || 0);
  const seekSeconds = durationSeconds > 2
    ? Math.min(Math.max(durationSeconds * 0.1, 5), durationSeconds - 1)
    : 0;
  const coverPath = path.join(outputDir, COVER_IMAGE_NAME);
  const args = [
    '-hide_banner',
    '-y',
    '-ss', seekSeconds.toFixed(3),
    '-i', filePath,
    '-map', `0:${renditions.sourceVideoIndex}`,
    '-frames:v', '1',
    '-q:v', '3',
    '-vf', "scale='min(640,iw)':-2",
    coverPath
  ];

  try {
    await runFfmpeg(args);
    return true;
  } catch (error) {
    console.error(`[Transcode] Cover image skipped: ${error.message}`);
    fs.rmSync(coverPath, { force: true });
    return false;
  }
}

function preserveExistingCoverImage(outputDir, stagingDir) {
  const seriesCoverPath = path.join(path.dirname(outputDir), COVER_IMAGE_NAME);
  if (path.basename(path.dirname(outputDir)) !== '.hls' && fs.existsSync(seriesCoverPath)) {
    fs.copyFileSync(seriesCoverPath, path.join(stagingDir, COVER_IMAGE_NAME));
    return true;
  }

  const existingCoverPath = path.join(outputDir, COVER_IMAGE_NAME);
  if (!fs.existsSync(existingCoverPath)) return false;

  fs.copyFileSync(existingCoverPath, path.join(stagingDir, COVER_IMAGE_NAME));
  return true;
}

function writeSubtitlePlaylist(subtitle, durationSeconds) {
  const duration = Math.max(1, Math.ceil(durationSeconds || 1));
  const content = [
    '#EXTM3U',
    `#EXT-X-VERSION:${HLS_PLAYLIST_VERSION}`,
    `#EXT-X-TARGETDURATION:${duration}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXTINF:${duration.toFixed(3)},`,
    subtitle.fileName,
    '#EXT-X-ENDLIST',
    ''
  ].join('\n');

  fs.writeFileSync(path.join(path.dirname(subtitle.filePath), 'sub.m3u8'), content);
}

function hlsBoolean(value) {
  return value ? 'YES' : 'NO';
}

function getAudioChannelsTag(channels) {
  if (channels >= 6) return '6';
  return '2';
}

function getVariantBandwidth(video, hasAudio) {
  return bitrateToBits(video.maxrate) + (hasAudio ? bitrateToBits(AUDIO_BITRATE) : 0);
}

function getVariantAverageBandwidth(video, hasAudio) {
  return video.averageBandwidth + (hasAudio ? bitrateToBits(AUDIO_BITRATE) : 0);
}

function writeMasterPlaylist(outputDir, renditions) {
  const hasAudio = renditions.audio.length > 0;
  const hasSubtitles = renditions.subtitles.length > 0;
  const lines = [
    '#EXTM3U',
    `#EXT-X-VERSION:${HLS_PLAYLIST_VERSION}`,
    '#EXT-X-INDEPENDENT-SEGMENTS'
  ];

  renditions.audio.forEach(audio => {
    lines.push(
      [
        '#EXT-X-MEDIA:TYPE=AUDIO',
        `GROUP-ID="${AUDIO_GROUP_ID}"`,
        `LANGUAGE="${audio.language}"`,
        `NAME="${audio.name}"`,
        `DEFAULT=${hlsBoolean(audio.isDefault)}`,
        'AUTOSELECT=YES',
        `CHANNELS="${getAudioChannelsTag(audio.channels)}"`,
        `URI="${audio.playlist}"`
      ].join(',')
    );
  });

  renditions.subtitles.forEach(subtitle => {
    lines.push(
      [
        '#EXT-X-MEDIA:TYPE=SUBTITLES',
        `GROUP-ID="${SUBTITLE_GROUP_ID}"`,
        `LANGUAGE="${subtitle.language}"`,
        `NAME="${subtitle.name}"`,
        `DEFAULT=${hlsBoolean(subtitle.isDefault)}`,
        `AUTOSELECT=${hlsBoolean(subtitle.isDefault || subtitle.isForced)}`,
        `FORCED=${hlsBoolean(subtitle.isForced)}`,
        `URI="${subtitle.playlist}"`
      ].join(',')
    );
  });

  renditions.video.forEach(video => {
    const codecs = hasAudio ? `${video.codecs},mp4a.40.2` : video.codecs;
    const attributes = [
      `BANDWIDTH=${getVariantBandwidth(video, hasAudio)}`,
      `AVERAGE-BANDWIDTH=${getVariantAverageBandwidth(video, hasAudio)}`,
      `RESOLUTION=${video.width}x${video.height}`,
      `FRAME-RATE=${video.frameRate}`,
      `CODECS="${codecs}"`
    ];

    if (hasAudio) {
      attributes.push(`AUDIO="${AUDIO_GROUP_ID}"`);
    }

    if (hasSubtitles) {
      attributes.push(`SUBTITLES="${SUBTITLE_GROUP_ID}"`);
    }

    lines.push(`#EXT-X-STREAM-INF:${attributes.join(',')}`);
    lines.push(video.playlist);
  });

  lines.push('');
  fs.writeFileSync(path.join(outputDir, 'master.m3u8'), lines.join('\n'));
}

function getQuotedAttribute(line, name) {
  const match = line.match(new RegExp(`${name}="([^"]+)"`));
  return match ? match[1] : null;
}

function readPlaylistLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
}

function resolvePlaylistUri(playlistPath, uri) {
  return path.resolve(path.dirname(playlistPath), uri.replace(/\?.*$/, ''));
}

function normalizeFmp4InitSegment(playlistPath) {
  const content = fs.readFileSync(playlistPath, 'utf8');
  const mapLine = content.split(/\r?\n/).find(line => line.startsWith('#EXT-X-MAP:'));
  if (!mapLine) {
    throw new Error(`Missing EXT-X-MAP in ${playlistPath}`);
  }

  const initUri = getQuotedAttribute(mapLine, 'URI');
  if (!initUri) {
    throw new Error(`Missing EXT-X-MAP URI in ${playlistPath}`);
  }

  if (initUri === 'init.mp4') return;

  const currentInitPath = resolvePlaylistUri(playlistPath, initUri);
  const normalizedInitPath = path.join(path.dirname(playlistPath), 'init.mp4');
  if (!fs.existsSync(currentInitPath)) {
    throw new Error(`Missing fMP4 init segment: ${currentInitPath}`);
  }

  fs.rmSync(normalizedInitPath, { force: true });
  fs.renameSync(currentInitPath, normalizedInitPath);
  fs.writeFileSync(playlistPath, content.replace(`URI="${initUri}"`, 'URI="init.mp4"'));
}

function normalizeFmp4Playlists(outputDir, renditions) {
  renditions.video.forEach(video => {
    normalizeFmp4InitSegment(path.join(outputDir, video.playlist));
  });

  renditions.audio.forEach(audio => {
    normalizeFmp4InitSegment(path.join(outputDir, audio.playlist));
  });
}

function validateFmp4Playlist(playlistPath) {
  if (!fs.existsSync(playlistPath)) {
    throw new Error(`Missing playlist: ${playlistPath}`);
  }

  const lines = readPlaylistLines(playlistPath);
  const mapLine = lines.find(line => line.startsWith('#EXT-X-MAP:'));
  if (!mapLine) {
    throw new Error(`Missing EXT-X-MAP in ${playlistPath}`);
  }

  const initUri = getQuotedAttribute(mapLine, 'URI');
  if (!initUri || !fs.existsSync(resolvePlaylistUri(playlistPath, initUri))) {
    throw new Error(`Missing fMP4 init segment for ${playlistPath}`);
  }

  const segmentUris = lines.filter(line => line && !line.startsWith('#') && line.endsWith('.m4s'));
  if (segmentUris.length === 0) {
    throw new Error(`No media segments in ${playlistPath}`);
  }

  segmentUris.forEach(uri => {
    const segmentPath = resolvePlaylistUri(playlistPath, uri);
    if (!fs.existsSync(segmentPath)) {
      throw new Error(`Missing media segment: ${segmentPath}`);
    }
  });

  if (!lines.includes('#EXT-X-ENDLIST')) {
    throw new Error(`Missing EXT-X-ENDLIST in ${playlistPath}`);
  }
}

function validateSubtitlePlaylist(playlistPath) {
  if (!fs.existsSync(playlistPath)) {
    throw new Error(`Missing subtitle playlist: ${playlistPath}`);
  }

  const lines = readPlaylistLines(playlistPath);
  const subtitleUris = lines.filter(line => line && !line.startsWith('#'));
  if (subtitleUris.length === 0) {
    throw new Error(`No subtitle segments in ${playlistPath}`);
  }

  subtitleUris.forEach(uri => {
    const subtitlePath = resolvePlaylistUri(playlistPath, uri);
    if (!fs.existsSync(subtitlePath)) {
      throw new Error(`Missing subtitle segment: ${subtitlePath}`);
    }
  });
}

function validateOutput(outputDir, renditions) {
  const masterPath = path.join(outputDir, 'master.m3u8');
  if (!fs.existsSync(masterPath)) {
    throw new Error('Missing master.m3u8');
  }

  const master = fs.readFileSync(masterPath, 'utf8');
  renditions.video.forEach(video => {
    if (!master.includes(video.playlist)) {
      throw new Error(`Master playlist missing video URI: ${video.playlist}`);
    }

    validateFmp4Playlist(path.join(outputDir, video.playlist));
  });

  renditions.audio.forEach(audio => {
    if (!master.includes(`URI="${audio.playlist}"`)) {
      throw new Error(`Master playlist missing audio URI: ${audio.playlist}`);
    }

    validateFmp4Playlist(path.join(outputDir, audio.playlist));
  });

  renditions.subtitles.forEach(subtitle => {
    if (!master.includes(`URI="${subtitle.playlist}"`)) {
      throw new Error(`Master playlist missing subtitle URI: ${subtitle.playlist}`);
    }

    validateSubtitlePlaylist(path.join(outputDir, subtitle.playlist));
  });
}

function isRetryableFsError(error) {
  return WINDOWS_RETRYABLE_FS_CODES.has(error?.code);
}

async function retryFsOperation(description, operation, options = {}) {
  const attempts = options.attempts || 12;
  const delayMs = options.delayMs || 250;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableFsError(error) || attempt === attempts) {
        break;
      }

      await sleep(delayMs * attempt);
    }
  }

  const error = new Error(`${description} failed: ${lastError.message}`);
  error.code = lastError.code;
  throw error;
}

async function replaceOutputDirectory(stagingDir, outputDir) {
  ensureDir(path.dirname(outputDir));

  await retryFsOperation('Remove existing HLS output', () => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  try {
    await retryFsOperation('Publish HLS output', () => {
      fs.renameSync(stagingDir, outputDir);
    });
    return;
  } catch (renameError) {
    if (!isRetryableFsError(renameError)) {
      throw renameError;
    }

    const copyDir = `${outputDir}.copy-${Date.now()}`;
    await retryFsOperation('Copy HLS output fallback', () => {
      fs.rmSync(copyDir, { recursive: true, force: true });
      fs.rmSync(outputDir, { recursive: true, force: true });
      fs.cpSync(stagingDir, copyDir, { recursive: true });
      fs.renameSync(copyDir, outputDir);
    }, { attempts: 6, delayMs: 500 });

    try {
      await retryFsOperation('Remove staged HLS output after fallback copy', () => {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }, { attempts: 6, delayMs: 500 });
    } catch (cleanupError) {
      console.warn(`[Transcode] Published output, but could not remove staging directory: ${cleanupError.message}`);
    }
  }
}

async function runTranscode(filename, filePath, outputDir, stagingDir, info, renditions) {
  const durationMs = Number(info.duration || 0) * 1000;
  const mediaArgs = buildMediaArgs(filePath, stagingDir, info, renditions);

  console.log(`[Transcode] ffmpeg ${mediaArgs.join(' ')}`);

  await runFfmpeg(mediaArgs, text => {
    const currentMs = parseFfmpegTime(text);
    if (currentMs === null || durationMs <= 0) return;

    const progress = Math.min(95, (currentMs / durationMs) * 100).toFixed(2);
    updateJob(filename, { status: 'processing', progress });
    transcodeEvents.emit('progress', { filename, progress });
  });

  normalizeFmp4Playlists(stagingDir, renditions);

  const extractedSubtitles = await Promise.all(
    renditions.subtitles.map(subtitle => extractSubtitle(filePath, subtitle, info.duration))
  );

  renditions.subtitles = renditions.subtitles.filter((_, index) => extractedSubtitles[index]);
  await extractCoverImage(filePath, stagingDir, info, renditions);
  preserveExistingCoverImage(outputDir, stagingDir);
  writeMasterPlaylist(stagingDir, renditions);
  validateOutput(stagingDir, renditions);
  try {
    await replaceOutputDirectory(stagingDir, outputDir);
  } catch (error) {
    error.keepStaging = true;
    error.message = `${error.message}. Valid staged output was kept at ${stagingDir}`;
    throw error;
  }

  updateJob(filename, { status: 'completed', progress: 100 });
  transcodeEvents.emit('progress', { filename, progress: 100 });
  transcodeEvents.emit('finished', { filename, status: 'completed' });
  console.log(`[Transcode] Finished: ${filename}`);
}

async function transcodeToHls(filePath, moviesDir, outputBaseDir) {
  const filename = path.relative(moviesDir, filePath).replace(/\\/g, '/');
  const currentJob = transcodeJobs.get(filename);

  if (currentJob?.status === 'processing') {
    return currentJob.id;
  }

  const outputDir = path.join(outputBaseDir, filename);
  const masterPath = path.join(outputDir, 'master.m3u8');
  if (fs.existsSync(masterPath)) {
    updateJob(filename, { id: 'existing', status: 'completed', progress: 100 });
    return 'existing';
  }

  const info = await getMediaInfo(filePath);
  const stagingDir = `${outputDir}.tmp-${Date.now()}`;
  ensureDir(stagingDir);

  const renditions = buildRenditions(info, stagingDir);
  const job = createJob(filename);

  job.promise = runTranscode(filename, filePath, outputDir, stagingDir, info, renditions)
    .catch(error => {
      if (!error.keepStaging) {
        try {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        } catch (cleanupError) {
          console.warn(`[Transcode] Could not remove failed staging directory: ${cleanupError.message}`);
        }
      }
      updateJob(filename, { status: 'error', progress: 0, error: error.message });
      transcodeEvents.emit('finished', { filename, status: 'error', error: error.message });
      console.error(`[Transcode] Error for ${filename}: ${error.message}`);
    });

  return job.id;
}

async function waitForTranscode(filename) {
  const job = transcodeJobs.get(filename);
  if (job?.promise) {
    await job.promise;
  }

  return getTranscodeStatus(filename);
}

function getTranscodeStatus(filename, outputBaseDir) {
  const job = transcodeJobs.get(filename);
  if (job) {
    const { promise, ...status } = job;
    return status;
  }

  if (outputBaseDir) {
    const masterPath = path.join(outputBaseDir, filename, 'master.m3u8');
    if (fs.existsSync(masterPath)) {
      return { status: 'completed', progress: 100 };
    }
  }

  return { status: 'idle', progress: 0 };
}

module.exports = {
  transcodeToHls,
  waitForTranscode,
  getTranscodeStatus,
  transcodeEvents
};
