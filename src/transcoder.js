const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const { getMediaInfo } = require('./media');

const HLS_SEGMENT_SECONDS = 6;
const VIDEO_BITRATE = '3500k';
const AUDIO_BITRATE = '192k';
const AUDIO_GROUP_ID = 'audio';
const SUBTITLE_GROUP_ID = 'subs';
const PLAYLIST_VERSION = 3;
const COVER_IMAGE_NAME = 'cover.jpg';
const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'srt', 'webvtt']);

const transcodeEvents = new EventEmitter();
const transcodeJobs = new Map();

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function toPosixPath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function cleanTagValue(value, fallback) {
  const text = String(value || fallback || '').trim();
  return text.replace(/["\r\n]/g, '');
}

function safeId(value, fallback) {
  const id = String(value || fallback || '').replace(/[^a-zA-Z0-9]/g, '');
  return id || fallback;
}

function isTextSubtitle(codec) {
  return TEXT_SUBTITLE_CODECS.has(codec);
}

function parseFfmpegTime(text) {
  const match = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
  if (!match) return null;

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseFloat(match[3]);
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
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

function buildRenditions(info, outputDir) {
  const video = info.video[0];
  if (!video) {
    throw new Error('No video stream found');
  }

  const defaultAudioIndex = getDefaultAudioIndex(info.audio);
  const height = video.height || 1080;
  const width = video.width || 1920;
  const videoName = `${height}p`;
  const videoPlaylist = `video/${videoName}/${videoName}.m3u8`;
  ensureDir(path.dirname(path.join(outputDir, videoPlaylist)));

  const audio = info.audio.map((stream, index) => {
    const language = safeId(stream.languageCode, `aud${index}`);
    const id = `${language}_${index}`;
    const playlist = `audio/${id}/audio.m3u8`;
    ensureDir(path.dirname(path.join(outputDir, playlist)));

    return {
      inputIndex: stream.index,
      outputIndex: index,
      language,
      name: cleanTagValue(stream.title || stream.language, language),
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
        name: cleanTagValue(stream.title || stream.language, language),
        isDefault: Boolean(stream.isDefault),
        isForced: Boolean(stream.isForced),
        playlist,
        fileName,
        filePath: path.join(dir, fileName)
      };
    });

  return {
    video: {
      inputIndex: video.index,
      width,
      height,
      name: videoName,
      playlist: videoPlaylist
    },
    audio,
    subtitles
  };
}

function buildMediaArgs(filePath, outputDir, renditions) {
  const args = [
    '-hide_banner',
    '-y',
    '-fflags', '+genpts',
    '-i', filePath,
    '-map', `0:${renditions.video.inputIndex}`,
    '-c:v:0', 'libx264',
    '-preset', 'fast',
    '-crf', '22',
    '-maxrate:v:0', VIDEO_BITRATE,
    '-bufsize:v:0', '7000k',
    '-pix_fmt', 'yuv420p',
    '-sc_threshold', '0',
    '-force_key_frames', `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`,
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-max_muxing_queue_size', '9999'
  ];

  renditions.audio.forEach(audio => {
    args.push(
      '-map', `0:${audio.inputIndex}`,
      `-c:a:${audio.outputIndex}`, 'aac',
      `-b:a:${audio.outputIndex}`, AUDIO_BITRATE,
      `-ac:a:${audio.outputIndex}`, '2'
    );
  });

  const streamMap = [
    `v:0,name:${renditions.video.playlist.replace(/\.m3u8$/, '')}`
  ];

  renditions.audio.forEach(audio => {
    streamMap.push(`a:${audio.outputIndex},name:${audio.playlist.replace(/\.m3u8$/, '')}`);
  });

  args.push(
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_SECONDS),
    '-hls_playlist_type', 'vod',
    '-hls_flags', '+independent_segments',
    '-hls_segment_type', 'mpegts',
    '-var_stream_map', streamMap.join(' '),
    '-hls_segment_filename', toPosixPath(path.join(outputDir, '%v_%03d.ts')),
    toPosixPath(path.join(outputDir, '%v.m3u8'))
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

      const lastLines = stderr.trim().split(/\r?\n/).slice(-8).join('\n');
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
    '-map', `0:${renditions.video.inputIndex}`,
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

function writeSubtitlePlaylist(subtitle, durationSeconds) {
  const duration = Math.max(1, Math.ceil(durationSeconds || 1));
  const content = [
    '#EXTM3U',
    `#EXT-X-VERSION:${PLAYLIST_VERSION}`,
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

function estimateBandwidth(hasAudio) {
  const videoBits = Number.parseInt(VIDEO_BITRATE, 10) * 1000;
  const audioBits = Number.parseInt(AUDIO_BITRATE, 10) * 1000;
  return videoBits + (hasAudio ? audioBits : 0);
}

function writeMasterPlaylist(outputDir, renditions) {
  const hasAudio = renditions.audio.length > 0;
  const bandwidth = estimateBandwidth(hasAudio);
  const codecs = hasAudio ? 'avc1.640028,mp4a.40.2' : 'avc1.640028';
  const attributes = [
    `BANDWIDTH=${bandwidth}`,
    `AVERAGE-BANDWIDTH=${bandwidth}`,
    `RESOLUTION=${renditions.video.width}x${renditions.video.height}`,
    `CODECS="${codecs}"`
  ];

  if (hasAudio) {
    attributes.push(`AUDIO="${AUDIO_GROUP_ID}"`);
  }

  if (renditions.subtitles.length > 0) {
    attributes.push(`SUBTITLES="${SUBTITLE_GROUP_ID}"`);
  }

  const lines = [
    '#EXTM3U',
    `#EXT-X-VERSION:${PLAYLIST_VERSION}`,
    '#EXT-X-INDEPENDENT-SEGMENTS'
  ];

  renditions.audio.forEach(audio => {
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${AUDIO_GROUP_ID}",LANGUAGE="${audio.language}",NAME="${audio.name}",DEFAULT=${hlsBoolean(audio.isDefault)},AUTOSELECT=YES,URI="${audio.playlist}"`
    );
  });

  renditions.subtitles.forEach(subtitle => {
    lines.push(
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="${SUBTITLE_GROUP_ID}",LANGUAGE="${subtitle.language}",NAME="${subtitle.name}",DEFAULT=${hlsBoolean(subtitle.isDefault)},AUTOSELECT=${hlsBoolean(subtitle.isDefault || subtitle.isForced)},FORCED=${hlsBoolean(subtitle.isForced)},URI="${subtitle.playlist}"`
    );
  });

  lines.push(`#EXT-X-STREAM-INF:${attributes.join(',')}`);
  lines.push(renditions.video.playlist);
  lines.push('');

  fs.writeFileSync(path.join(outputDir, 'master.m3u8'), lines.join('\n'));
}

function replaceOutputDirectory(stagingDir, outputDir) {
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.renameSync(stagingDir, outputDir);
}

async function runTranscode(filename, filePath, outputDir, stagingDir, info, renditions) {
  const durationMs = Number(info.duration || 0) * 1000;
  const mediaArgs = buildMediaArgs(filePath, stagingDir, renditions);

  console.log(`[Transcode] ffmpeg ${mediaArgs.join(' ')}`);

  await runFfmpeg(mediaArgs, text => {
    const currentMs = parseFfmpegTime(text);
    if (currentMs === null || durationMs <= 0) return;

    const progress = Math.min(99, (currentMs / durationMs) * 100).toFixed(2);
    updateJob(filename, { status: 'processing', progress });
    transcodeEvents.emit('progress', { filename, progress });
  });

  const extractedSubtitles = await Promise.all(
    renditions.subtitles.map(subtitle => extractSubtitle(filePath, subtitle, info.duration))
  );

  renditions.subtitles = renditions.subtitles.filter((_, index) => extractedSubtitles[index]);
  await extractCoverImage(filePath, stagingDir, info, renditions);
  writeMasterPlaylist(stagingDir, renditions);
  replaceOutputDirectory(stagingDir, outputDir);

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

  const info = await getMediaInfo(filePath);
  const outputDir = path.join(outputBaseDir, filename);
  const stagingDir = `${outputDir}.tmp-${Date.now()}`;
  ensureDir(stagingDir);

  const renditions = buildRenditions(info, stagingDir);
  const job = createJob(filename);

  job.promise = runTranscode(filename, filePath, outputDir, stagingDir, info, renditions)
    .catch(error => {
      fs.rmSync(stagingDir, { recursive: true, force: true });
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
