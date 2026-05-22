const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

// Allowed video extensions
const VIDEO_EXTENSIONS = ['.mkv', '.mp4', '.avi', '.mov', '.wmv'];
const SAFE_FALLBACK_NAME = 'media';

const LANGUAGE_MAP = {
  'vie': 'Vietnamese',
  'chi': 'Chinese',
  'zho': 'Chinese',
  'eng': 'English',
  'jpn': 'Japanese',
  'kor': 'Korean',
  'fre': 'French',
  'ger': 'German',
  'spa': 'Spanish',
  'rus': 'Russian',
  'und': 'Unknown'
};

/**
 * Convert file/folder names into URL-friendly names.
 * Keeps only ASCII letters and numbers, plus the file extension dot.
 */
function sanitizeName(name, fallback = SAFE_FALLBACK_NAME) {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;

  const safeBase = base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '')
    .replace(/[^a-zA-Z0-9]/g, '');

  const safeExt = ext
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9.]/g, '');

  return `${safeBase || fallback}${safeExt}`;
}

function getUniqueSafeName(dirPath, originalName, usedNames) {
  const desiredName = sanitizeName(originalName);
  const ext = path.extname(desiredName);
  const base = ext ? desiredName.slice(0, -ext.length) : desiredName;

  let candidate = desiredName;
  let suffix = 1;

  while (
    usedNames.has(candidate.toLowerCase()) &&
    candidate.toLowerCase() !== originalName.toLowerCase()
  ) {
    candidate = `${base}${suffix}${ext}`;
    suffix++;
  }

  while (
    fs.existsSync(path.join(dirPath, candidate)) &&
    candidate.toLowerCase() !== originalName.toLowerCase()
  ) {
    candidate = `${base}${suffix}${ext}`;
    suffix++;
  }

  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function renameHlsPath(hlsOutputDir, oldRelPath, newRelPath) {
  if (!hlsOutputDir) return;

  const oldHlsPath = path.join(hlsOutputDir, oldRelPath);
  const newHlsPath = path.join(hlsOutputDir, newRelPath);

  if (!fs.existsSync(oldHlsPath) || oldHlsPath === newHlsPath) return;
  if (fs.existsSync(newHlsPath)) {
    console.warn(`[Media] Cannot rename HLS path because target exists: ${newHlsPath}`);
    return;
  }

  fs.mkdirSync(path.dirname(newHlsPath), { recursive: true });
  fs.renameSync(oldHlsPath, newHlsPath);
}

/**
 * Rename movie folders/files to URL-friendly names before scanning.
 */
async function normalizeMediaNames(dirPath, hlsOutputDir, subDir = '') {
  const currentPath = path.join(dirPath, subDir);
  if (!fs.existsSync(currentPath)) return;

  const entries = fs.readdirSync(currentPath, { withFileTypes: true })
    .filter(dirent => !dirent.name.startsWith('.'));
  const usedNames = new Set(entries.map(dirent => dirent.name.toLowerCase()));
  const normalizedDirs = [];

  for (const dirent of entries) {
    if (!dirent.isDirectory() && !dirent.isFile()) continue;

    const oldName = dirent.name;
    const newName = getUniqueSafeName(currentPath, oldName, usedNames);
    const oldPath = path.join(currentPath, oldName);
    const newPath = path.join(currentPath, newName);
    const oldRelPath = path.join(subDir, oldName);
    const newRelPath = path.join(subDir, newName);

    if (oldName !== newName) {
      fs.renameSync(oldPath, newPath);
      renameHlsPath(hlsOutputDir, oldRelPath, newRelPath);
      console.log(`[Media] Renamed "${oldRelPath}" -> "${newRelPath}"`);
    }

    if (dirent.isDirectory()) {
      normalizedDirs.push(newRelPath);
    }
  }

  for (const childDir of normalizedDirs) {
    await normalizeMediaNames(dirPath, hlsOutputDir, childDir);
  }
}

/**
 * Scan directory for movies
 */
async function scanMovies(dirPath, hlsOutputDir, subDir = '', options = {}) {
  if (!subDir && options.normalizeNames !== false) {
    await normalizeMediaNames(dirPath, hlsOutputDir);
  }

  return new Promise((resolve, reject) => {
    const currentPath = path.join(dirPath, subDir);
    fs.readdir(currentPath, { withFileTypes: true }, async (err, files) => {
      if (err) {
        if (err.code === 'ENOENT') {
          return resolve([]); // Directory doesn't exist
        }
        return reject(err);
      }

      let movies = [];
      for (const dirent of files) {
        if (dirent.name.startsWith('.')) continue;

        if (dirent.isDirectory()) {
          try {
            const subMovies = await scanMovies(dirPath, hlsOutputDir, path.join(subDir, dirent.name));
            movies = movies.concat(subMovies);
          } catch (e) {
            console.error(`Error scanning subdirectory ${dirent.name}:`, e);
          }
        } else if (dirent.isFile() && VIDEO_EXTENSIONS.includes(path.extname(dirent.name).toLowerCase())) {
          const name = dirent.name;
          const relPath = path.join(subDir, name).replace(/\\/g, '/');
          let isTranscoded = false;
          let hasCover = false;
          if (hlsOutputDir) {
            const masterPath = path.join(hlsOutputDir, relPath, 'master.m3u8');
            const coverPath = path.join(hlsOutputDir, relPath, 'cover.jpg');
            isTranscoded = fs.existsSync(masterPath);
            hasCover = fs.existsSync(coverPath);
          }
          movies.push({ 
            name, 
            path: relPath, 
            folder: subDir.replace(/\\/g, '/'), 
            isTranscoded,
            hasCover
          });
        }
      }
      resolve(movies);
    });
  });
}

/**
 * Get media information (video, audio, subtitle streams)
 */
async function getMediaInfo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);

      const streams = metadata.streams;
      
      const info = {
        format: metadata.format,
        duration: metadata.format.duration,
        video: [],
        audio: [],
        subtitle: []
      };

      streams.forEach(stream => {
        const codecType = stream.codec_type;
        const tags = stream.tags || {};
        const disposition = stream.disposition || {};
        
        let langCode = (tags.language || tags.LANGUAGE || 'und').toLowerCase();
        let language = LANGUAGE_MAP[langCode] || langCode;
        
        const streamInfo = {
          index: stream.index,
          codec: stream.codec_name,
          language: language,
          languageCode: langCode,
          title: tags.title || tags.TITLE || '',
          isDefault: disposition.default === 1,
          isForced: disposition.forced === 1
        };

        if (codecType === 'video') {
          // Sometimes videos have attached pictures (cover art) which are marked as video streams
          if (disposition.attached_pic === 1) {
             return;
          }
          streamInfo.width = stream.width;
          streamInfo.height = stream.height;
          streamInfo.frameRate = stream.avg_frame_rate || stream.r_frame_rate || '';
          info.video.push(streamInfo);
        } else if (codecType === 'audio') {
          streamInfo.channels = stream.channels;
          // Generate a descriptive title if missing
          if (!streamInfo.title) {
            let desc = language;
            if (stream.codec_name) desc += ` (${stream.codec_name})`;
            if (stream.channels) desc += ` ${stream.channels === 6 ? '5.1' : stream.channels === 2 ? 'Stereo' : stream.channels + 'ch'}`;
            streamInfo.title = desc;
          }
          info.audio.push(streamInfo);
        } else if (codecType === 'subtitle') {
          if (!streamInfo.title) {
            streamInfo.title = language;
          }
          
          // Deduplicate: only add if we haven't seen this language and title combination
          // However, prioritize tracks marked as default or forced
          const subKey = `${streamInfo.languageCode}_${streamInfo.title}`;
          const existingIndex = info.subtitle.findIndex(s => `${s.languageCode}_${s.title}` === subKey);
          
          if (existingIndex === -1) {
            info.subtitle.push(streamInfo);
          } else if (streamInfo.isDefault || streamInfo.isForced) {
            // Replace existing if the new one is default or forced
            info.subtitle[existingIndex] = streamInfo;
          }
        }
      });

      resolve(info);
    });
  });
}

/**
 * Delete media files and associated HLS data
 * @param {string} relPath Relative path of the movie
 * @param {string} moviesDir Root movies directory
 * @param {string} hlsOutputDir HLS output directory
 * @param {object} options { deleteOriginal: boolean }
 */
async function deleteMedia(relPath, moviesDir, hlsOutputDir, options = {}) {
  const { deleteOriginal = false } = options;
  
  // 1. Delete HLS data
  const hlsPath = path.join(hlsOutputDir, relPath);
  if (fs.existsSync(hlsPath)) {
    console.log(`[Media] Deleting HLS data: ${hlsPath}`);
    fs.rmSync(hlsPath, { recursive: true, force: true });
  }

  // 2. Delete original file
  if (deleteOriginal) {
    const originalPath = path.join(moviesDir, relPath);
    if (fs.existsSync(originalPath)) {
      console.log(`[Media] Deleting original file: ${originalPath}`);
      const stats = fs.statSync(originalPath);
      if (stats.isDirectory()) {
        fs.rmSync(originalPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(originalPath);
      }
    }
  }
}

module.exports = {
  scanMovies,
  getMediaInfo,
  deleteMedia,
  normalizeMediaNames,
  sanitizeName
};
