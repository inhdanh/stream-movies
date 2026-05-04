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

async function extractSubtitle(filePath, subStream, outputDir, index) {
  return new Promise((resolve, reject) => {
    const vttFile = `sub_${index}.vtt`;
    const vttPath = path.join(outputDir, vttFile);
    const m3u8Path = path.join(outputDir, `sub_${index}.m3u8`);
    
    const args = [
      '-i', filePath,
      '-y',
      '-map', `0:${subStream.index}`,
      '-c:s', 'webvtt',
      vttPath
    ];

    const proc = spawn('ffmpeg', args);
    proc.on('close', (code) => {
      if (code === 0) {
        // Create m3u8 for subtitle
        // Just a single segment for the whole VTT
        const duration = 36000; // max safe duration or we can use info.duration
        const m3u8Content = `#EXTM3U\n#EXT-X-TARGETDURATION:${duration}\n#EXT-X-VERSION:3\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:${duration}.000,\n${vttFile}\n#EXT-X-ENDLIST\n`;
        fs.writeFileSync(m3u8Path, m3u8Content);
        resolve();
      } else {
        console.error(`Error extracting subtitle ${index}`);
        resolve(); // resolve anyway to not break main process
      }
    });
  });
}

function rewriteMasterPlaylist(masterPath, info) {
  if (!fs.existsSync(masterPath)) return;
  
  let content = fs.readFileSync(masterPath, 'utf8');
  
  let subLines = '';
  let sIndex = 0;
  info.subtitle.forEach((sub) => {
    if (isSubtitleTextBased(sub.codec)) {
      const lang = sub.language || `sub${sIndex}`;
      const name = sub.title || lang;
      const isDefault = sIndex === 0 ? 'YES' : 'NO';
      const isAuto = sIndex === 0 ? 'YES' : 'NO';
      
      subLines += `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="${lang}",NAME="${name}",AUTOSELECT=${isAuto},DEFAULT=${isDefault},URI="sub_${sIndex}.m3u8"\n`;
      sIndex++;
    }
  });

  if (subLines) {
    // Insert subLines before the first #EXT-X-STREAM-INF
    const parts = content.split('#EXT-X-STREAM-INF');
    if (parts.length > 1) {
      // Add SUBTITLES="subs" to the video stream definition
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

  // 1. Start Subtitle extraction in parallel
  const subPromises = [];
  let sIndex = 0;
  info.subtitle.forEach((sub) => {
    if (isSubtitleTextBased(sub.codec)) {
      subPromises.push(extractSubtitle(filePath, sub, outputDir, sIndex));
      sIndex++;
    }
  });

  // 2. Transcode Video and Audio
  const args = ['-i', filePath, '-y'];
  let varStreamMap = [];

  const videoStream = info.video[0];
  if (videoStream) {
    args.push('-map', `0:${videoStream.index}`);
    if (isVideoCompatible(videoStream.codec)) {
      args.push('-c:v:0', 'copy');
    } else {
      args.push('-c:v:0', 'libx264', '-preset', 'fast', '-crf', '23');
    }
    varStreamMap.push(`v:0,agroup:audio`);
  }

  let aIndex = 0;
  info.audio.forEach((audio) => {
    args.push('-map', `0:${audio.index}`);
    args.push(`-c:a:${aIndex}`, 'aac', `-b:a:${aIndex}`, '192k');
    
    const lang = audio.language || `aud${aIndex}`;
    const name = audio.title || lang;
    const isDefault = aIndex === 0 ? 'YES' : 'NO';
    
    varStreamMap.push(`a:${aIndex},agroup:audio,language:${lang},name:${name},default:${isDefault}`);
    aIndex++;
  });

  const varStreamStr = varStreamMap.join(' ');

  args.push(
    '-f', 'hls',
    '-hls_time', '10',
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(outputDir, '%v_segment_%03d.ts'),
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', varStreamStr,
    path.join(outputDir, '%v_playlist.m3u8')
  );

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
      // Wait for subtitles to finish extracting
      await Promise.all(subPromises);
      
      // Rewrite master playlist to inject subtitles
      rewriteMasterPlaylist(path.join(outputDir, 'master.m3u8'), info);

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
