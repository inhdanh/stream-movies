const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { getMediaInfo } = require('./media');

const transcodeJobs = new Map();

function isVideoCompatible(codec) {
  return ['h264', 'hevc'].includes(codec);
}

function isSubtitleTextBased(codec) {
  return ['subrip', 'ass', 'ssa', 'mov_text', 'srt', 'webvtt'].includes(codec);
}

async function extractSubtitle(filePath, subStream, subDir, lang) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(subDir)) {
      fs.mkdirSync(subDir, { recursive: true });
    }
    const vttFile = `seg_001.vtt`;
    const vttPath = path.join(subDir, vttFile);
    const m3u8Path = path.join(subDir, `sub.m3u8`);
    
    const args = [
      '-fflags', '+genpts',
      '-i', filePath,
      '-y',
      '-map', `0:${subStream.index}`,
      '-c:s', 'webvtt',
      vttPath
    ];

    const proc = spawn('ffmpeg', args);
    proc.on('close', (code) => {
      if (code === 0) {
        const duration = 36000;
        const m3u8Content = `#EXTM3U\n#EXT-X-TARGETDURATION:${duration}\n#EXT-X-VERSION:3\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:${duration}.000,\n${vttFile}\n#EXT-X-ENDLIST\n`;
        fs.writeFileSync(m3u8Path, m3u8Content);
        resolve();
      } else {
        console.error(`Error extracting subtitle ${lang}`);
        resolve(); // continue anyway
      }
    });
  });
}

function rewriteMasterPlaylist(masterPath, subStreamsInfo) {
  if (!fs.existsSync(masterPath)) return;
  
  let content = fs.readFileSync(masterPath, 'utf8');
  
  let subLines = '';
  subStreamsInfo.forEach((sub) => {
      subLines += `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="${sub.lang}",NAME="${sub.name}",AUTOSELECT=${sub.isDefault},DEFAULT=${sub.isDefault},URI="${sub.uri}"\n`;
  });

  if (subLines) {
    const parts = content.split('#EXT-X-STREAM-INF');
    if (parts.length > 1) {
      let newContent = parts[0] + subLines;
      for (let i = 1; i < parts.length; i++) {
        let streamInf = parts[i];
        if (!streamInf.includes('SUBTITLES=')) {
          let newlineIdx = streamInf.indexOf('\n');
          if (newlineIdx !== -1) {
             streamInf = streamInf.substring(0, newlineIdx) + ',SUBTITLES="subs"' + streamInf.substring(newlineIdx);
          }
        }
        newContent += '#EXT-X-STREAM-INF' + streamInf;
      }
      fs.writeFileSync(masterPath, newContent);
    }
  }
}

async function transcodeToHls(filePath, moviesDir, outputBaseDir) {
  const filename = path.basename(filePath);
  
  if (transcodeJobs.has(filename)) {
    const job = transcodeJobs.get(filename);
    if (job.status === 'processing') {
      return job.id;
    }
  }

  const outputDir = path.join(outputBaseDir, filename);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const info = await getMediaInfo(filePath);
  
  const jobId = Date.now().toString();
  transcodeJobs.set(filename, { id: jobId, status: 'processing', progress: 0 });

  const subPromises = [];
  const subStreamsInfo = [];
  let sIndex = 0;
  info.subtitle.forEach((sub) => {
    if (isSubtitleTextBased(sub.codec)) {
      let lang = sub.language || `sub${sIndex}`;
      let name = sub.title || lang;
      lang = lang.replace(/[^a-zA-Z0-9]/g, '');
      let uniqueLang = `${lang}_${sIndex}`;
      const subDir = path.join(outputDir, 'subtitles', uniqueLang);
      
      const isDefault = sIndex === 0 ? 'YES' : 'NO';
      subStreamsInfo.push({
        lang,
        name,
        isDefault,
        uri: `subtitles/${uniqueLang}/sub.m3u8`
      });

      subPromises.push(extractSubtitle(filePath, sub, subDir, lang));
      sIndex++;
    }
  });

  const args = [
    '-copyts',
    '-fflags', '+genpts', 
    '-i', filePath, 
    '-y',
    '-muxdelay', '0',
    '-max_muxing_queue_size', '9999'
  ];
  let varStreamMap = [];

  const videoStream = info.video[0];
  if (videoStream) {
    let height = videoStream.height || '1080';
    let resName = `${height}p`;
    
    const videoDir = path.join(outputDir, 'video', resName);
    if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

    args.push('-map', `0:${videoStream.index}`);
    if (isVideoCompatible(videoStream.codec)) {
      args.push('-c:v:0', 'copy');
    } else {
      args.push('-c:v:0', 'libx264', '-preset', 'fast', '-crf', '23');
    }
    varStreamMap.push(`v:0,name:video/${resName}/${resName},agroup:audio`);
  }

  let aIndex = 0;
  info.audio.forEach((audio) => {
    let lang = audio.language || `aud${aIndex}`;
    let name = audio.title || lang;
    lang = lang.replace(/[^a-zA-Z0-9]/g, '');
    let uniqueLang = `${lang}_${aIndex}`;
    
    const audioDir = path.join(outputDir, 'audio', uniqueLang);
    if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

    args.push('-map', `0:${audio.index}`);
    args.push(`-c:a:${aIndex}`, 'aac', `-b:a:${aIndex}`, '192k', '-ac', '2'); // Mixdown to stereo to ensure compatibility and sync
    
    let isDefault = aIndex === 0 ? 'YES' : 'NO';
    varStreamMap.push(`a:${aIndex},name:audio/${uniqueLang}/audio,agroup:audio,language:${lang},default:${isDefault}`);
    aIndex++;
  });

  if (varStreamMap.length > 0) {
    args.push(
      '-f', 'hls',
      '-hls_time', '10',
      '-hls_playlist_type', 'vod',
      '-hls_flags', 'independent_segments',
      '-master_pl_name', 'master.m3u8',
      '-var_stream_map', varStreamMap.join(' '),
      '-hls_segment_filename', path.join(outputDir, '%v_%03d.ts').replace(/\\/g, '/'),
      path.join(outputDir, '%v.m3u8').replace(/\\/g, '/')
    );
  }

  console.log('Spawning ffmpeg with args:', args.join(' '));

  const ffmpegProc = spawn('ffmpeg', args);
  let durationMs = info.duration * 1000;
  
  ffmpegProc.stderr.on('data', (data) => {
    const text = data.toString();
    const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
    if (timeMatch && durationMs > 0) {
      const hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      const seconds = parseFloat(timeMatch[3]);
      
      const currentMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
      let percent = (currentMs / durationMs) * 100;
      if (percent > 100) percent = 100;
      
      transcodeJobs.set(filename, { id: jobId, status: 'processing', progress: percent.toFixed(2) });
    }
  });

  ffmpegProc.on('close', async (code) => {
    if (code === 0) {
      await Promise.all(subPromises);
      rewriteMasterPlaylist(path.join(outputDir, 'master.m3u8'), subStreamsInfo);
      console.log(`[Transcode] Finished: ${filename}`);
      transcodeJobs.set(filename, { id: jobId, status: 'completed', progress: 100 });
    } else {
      console.error(`[Transcode] Error for ${filename}: ffmpeg exited with code ${code}`);
      transcodeJobs.set(filename, { id: jobId, status: 'error', progress: 0, error: `Exited with code ${code}` });
    }
  });

  return jobId;
}

function getTranscodeStatus(filename) {
  if (transcodeJobs.has(filename)) {
    return transcodeJobs.get(filename);
  }
  return { status: 'idle', progress: 0 };
}

module.exports = {
  transcodeToHls,
  getTranscodeStatus
};
