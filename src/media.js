const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { loadMetadata, getMovieDisplayMetadata } = require('./metadata');

// Allowed video extensions
const VIDEO_EXTENSIONS = ['.mkv', '.mp4', '.avi', '.mov', '.wmv'];
const SAFE_FALLBACK_NAME = 'media';
const GENERATED_VARIANT_SUFFIXES = [
  '4khevcaac',
  '4k_hevc_aac',
  'remuxfull',
  'remux_full'
];

const LANGUAGE_CODE_ALIASES = {
  chi: 'zh',
  zho: 'zh',
  cmn: 'zh',
  vie: 'vi',
  eng: 'en',
  jpn: 'ja',
  kor: 'ko',
  fre: 'fr',
  fra: 'fr',
  ger: 'de',
  deu: 'de',
  spa: 'es',
  rus: 'ru',
  und: 'und'
};

const LANGUAGE_MAP = {
  zh: 'Chinese',
  vi: 'Vietnamese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  ru: 'Russian',
  und: 'Unknown'
};

const AUDIO_TITLE_KEYWORDS = [
  'audio',
  'commentary',
  'descriptive',
  'dub',
  'dubbed',
  'original',
  'surround',
  'stereo',
  'thuyet',
  'thuyết',
  'tieng',
  'tiếng',
  'long tieng',
  'lồng tiếng',
  'mandarin',
  'cantonese',
  'viet'
];

function getTagValue(tags, names) {
  for (const name of names) {
    const value = tags[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim().replace(/[\r\n]+/g, ' ');
    }
  }
  return '';
}

function normalizeLanguageCode(value) {
  const raw = String(value || 'und').trim().toLowerCase().replace(/_/g, '-');
  if (!raw) return 'und';

  const parts = raw.split('-').filter(Boolean);
  const primary = LANGUAGE_CODE_ALIASES[parts[0]] || parts[0];
  if (!primary || primary === 'und') return 'und';

  const normalizedParts = [primary, ...parts.slice(1).map(part => (
    part.length === 2 ? part.toUpperCase() : part
  ))];

  return normalizedParts.join('-');
}

function getLanguageName(languageCode) {
  const primary = String(languageCode || 'und').split('-')[0];
  return LANGUAGE_MAP[primary] || languageCode || 'Unknown';
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isUsefulAudioTitle(title, language) {
  const text = String(title || '').trim();
  if (!text) return false;

  const normalizedTitle = normalizeSearchText(text);
  const normalizedLanguage = normalizeSearchText(language);
  if (normalizedTitle === normalizedLanguage) return false;

  if (/^(aac|ac-?3|e-?ac-?3|eac3|flac|truehd|dts|opus|mp3)([\s._-]*(2\.0|5\.1|7\.1|stereo|mono|audio))*$/i.test(text)) {
    return false;
  }

  const hasDescriptor = AUDIO_TITLE_KEYWORDS.some(keyword => normalizedTitle.includes(keyword));
  if (hasDescriptor) return true;

  if (/[()[\]\s]/.test(text)) return true;

  // Release-group tags such as "canodinh" are valid MKV titles but poor
  // labels for a player audio menu. Keep single-token titles only when
  // they look intentionally descriptive.
  if (/^[a-z0-9_-]{3,24}$/i.test(text)) return false;

  return true;
}

function getAudioCodecLabel(stream) {
  const codec = String(stream.codec_name || '').toLowerCase();
  const profile = String(stream.profile || '').toLowerCase();
  const hasAtmos = profile.includes('atmos');

  if (codec === 'eac3') return hasAtmos ? 'Dolby Digital Plus Atmos' : 'Dolby Digital Plus';
  if (codec === 'ac3') return 'Dolby Digital';
  if (codec === 'truehd') return hasAtmos ? 'Dolby TrueHD Atmos' : 'Dolby TrueHD';
  if (codec === 'aac') return 'AAC';
  if (codec === 'flac') return 'FLAC';
  if (codec === 'opus') return 'Opus';
  if (codec === 'mp3') return 'MP3';
  if (codec === 'dts') return 'DTS';

  return codec ? codec.toUpperCase() : 'Audio';
}

function getAudioChannelLabel(stream) {
  const layout = String(stream.channel_layout || '').toLowerCase();
  const channels = Number(stream.channels);

  if (layout.includes('7.1') || channels >= 8) return '7.1';
  if (layout.includes('5.1') || channels >= 6) return '5.1';
  if (layout.includes('stereo') || channels === 2) return 'Stereo';
  if (layout.includes('mono') || channels === 1) return 'Mono';
  if (Number.isFinite(channels) && channels > 0) return `${channels} ch`;

  return '';
}

function getAudioRoleLabels(disposition = {}) {
  const roles = [];
  if (disposition.original === 1) roles.push('Original');
  if (disposition.dub === 1) roles.push('Dub');
  if (disposition.comment === 1) roles.push('Commentary');
  if (disposition.visual_impaired === 1 || disposition.descriptions === 1) roles.push('Audio Description');
  if (disposition.hearing_impaired === 1) roles.push('Hard of Hearing');
  return roles;
}

function buildAudioFallbackTitle(stream, language, disposition) {
  return [
    language,
    ...getAudioRoleLabels(disposition),
    getAudioCodecLabel(stream),
    getAudioChannelLabel(stream)
  ].filter(Boolean).join(' - ');
}

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

async function getMediaSummary(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.warn(`[Media] Failed to read media info for ${filePath}: ${err.message}`);
        resolve({
          durationSeconds: null,
          sourceWidth: null,
          sourceHeight: null
        });
        return;
      }

      const duration = Number(metadata?.format?.duration);
      const video = (metadata?.streams || []).find(stream => (
        stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1
      ));
      const sourceWidth = Number(video?.width);
      const sourceHeight = Number(video?.height);

      resolve({
        durationSeconds: Number.isFinite(duration) && duration >= 0 ? duration : null,
        sourceWidth: Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : null,
        sourceHeight: Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : null
      });
    });
  });
}

function getHlsCoverState(hlsOutputDir, relPath) {
  let hasCover = false;
  let coverBasePath = relPath;

  if (!hlsOutputDir) {
    return { hasCover, coverBasePath };
  }

  const folder = path.dirname(relPath).replace(/\\/g, '/');
  const seriesCoverBasePath = folder && folder !== '.' ? folder : '';
  const seriesCoverPath = seriesCoverBasePath
    ? path.join(hlsOutputDir, seriesCoverBasePath, 'cover.jpg')
    : null;
  const movieCoverPath = path.join(hlsOutputDir, relPath, 'cover.jpg');

  if (seriesCoverPath && fs.existsSync(seriesCoverPath)) {
    hasCover = true;
    coverBasePath = seriesCoverBasePath;
  } else {
    hasCover = fs.existsSync(movieCoverPath);
  }

  return { hasCover, coverBasePath };
}

function getHlsSummary(masterPath) {
  try {
    const master = fs.readFileSync(masterPath, 'utf8');
    const resolutionMatch = master.match(/RESOLUTION=(\d+)x(\d+)/);
    const sourceWidth = resolutionMatch ? Number(resolutionMatch[1]) : null;
    const sourceHeight = resolutionMatch ? Number(resolutionMatch[2]) : null;

    return {
      durationSeconds: null,
      sourceWidth: Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : null,
      sourceHeight: Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : null
    };
  } catch (error) {
    console.warn(`[Media] Failed to read HLS summary for ${masterPath}: ${error.message}`);
    return {
      durationSeconds: null,
      sourceWidth: null,
      sourceHeight: null
    };
  }
}

function isStagingHlsDir(name) {
  return /\.tmp-\d+$/.test(name) || /\.copy-\d+$/.test(name);
}

function isGeneratedVariantFile(name) {
  const ext = path.extname(name).toLowerCase();
  if (!VIDEO_EXTENSIONS.includes(ext)) return false;

  const base = name.slice(0, -ext.length).toLowerCase();
  return GENERATED_VARIANT_SUFFIXES.some(suffix => base.endsWith(suffix));
}

async function scanHlsMoviePaths(hlsOutputDir, subDir = '') {
  const currentPath = path.join(hlsOutputDir, subDir);

  return new Promise((resolve, reject) => {
    fs.readdir(currentPath, { withFileTypes: true }, async (err, entries) => {
      if (err) {
        if (err.code === 'ENOENT') return resolve([]);
        return reject(err);
      }

      const masterPath = path.join(currentPath, 'master.m3u8');
      if (fs.existsSync(masterPath)) {
        return resolve([subDir.replace(/\\/g, '/')]);
      }

      entries.sort((a, b) => a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: 'base'
      }));

      let moviePaths = [];
      for (const dirent of entries) {
        if (!dirent.isDirectory() || dirent.name.startsWith('.') || isStagingHlsDir(dirent.name)) {
          continue;
        }

        try {
          const subPaths = await scanHlsMoviePaths(hlsOutputDir, path.join(subDir, dirent.name));
          moviePaths = moviePaths.concat(subPaths);
        } catch (error) {
          console.error(`Error scanning HLS subdirectory ${dirent.name}:`, error);
        }
      }

      resolve(moviePaths);
    });
  });
}

async function scanHlsOnlyMovies(hlsOutputDir, existingPaths, metadata, folderEpisodeCounts) {
  if (!hlsOutputDir || !fs.existsSync(hlsOutputDir)) return [];

  const hlsPaths = await scanHlsMoviePaths(hlsOutputDir);
  const movies = [];

  for (const relPath of hlsPaths) {
    if (!relPath || existingPaths.has(relPath)) continue;

    const folder = path.dirname(relPath).replace(/\\/g, '/');
    const normalizedFolder = folder && folder !== '.' ? folder : '';
    const name = path.basename(relPath);
    const masterPath = path.join(hlsOutputDir, relPath, 'master.m3u8');
    const baseMovie = {
      name,
      path: relPath,
      folder: normalizedFolder,
      isTranscoded: true,
      ...getHlsCoverState(hlsOutputDir, relPath),
      ...getHlsSummary(masterPath)
    };
    const episodeIndex = folderEpisodeCounts.get(normalizedFolder) || 0;
    const displayMetadata = getMovieDisplayMetadata(baseMovie, metadata, episodeIndex);
    folderEpisodeCounts.set(normalizedFolder, episodeIndex + 1);

    movies.push({
      ...baseMovie,
      ...displayMetadata,
      sourceMissing: true
    });
  }

  return movies;
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

  const metadata = options.metadata || loadMetadata();

  return new Promise((resolve, reject) => {
    const currentPath = path.join(dirPath, subDir);
    fs.readdir(currentPath, { withFileTypes: true }, async (err, files) => {
      if (err) {
        if (err.code === 'ENOENT') {
          return resolve([]); // Directory doesn't exist
        }
        return reject(err);
      }

      files.sort((a, b) => a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: 'base'
      }));

      let movies = [];
      let episodeIndex = 0;
      const existingPaths = options.existingPaths || new Set();
      const folderEpisodeCounts = options.folderEpisodeCounts || new Map();
      for (const dirent of files) {
        if (dirent.name.startsWith('.')) continue;

        if (dirent.isDirectory()) {
          try {
            const subMovies = await scanMovies(dirPath, hlsOutputDir, path.join(subDir, dirent.name), {
              ...options,
              metadata,
              normalizeNames: false,
              includeHlsOnly: false,
              existingPaths,
              folderEpisodeCounts
            });
            movies = movies.concat(subMovies);
          } catch (e) {
            console.error(`Error scanning subdirectory ${dirent.name}:`, e);
          }
        } else if (
          dirent.isFile() &&
          VIDEO_EXTENSIONS.includes(path.extname(dirent.name).toLowerCase()) &&
          !isGeneratedVariantFile(dirent.name)
        ) {
          const name = dirent.name;
          const relPath = path.join(subDir, name).replace(/\\/g, '/');
          const filePath = path.join(dirPath, subDir, name);
          let isTranscoded = false;
          let coverState = { hasCover: false, coverBasePath: relPath };
          if (hlsOutputDir) {
            const masterPath = path.join(hlsOutputDir, relPath, 'master.m3u8');
            isTranscoded = fs.existsSync(masterPath);
            coverState = getHlsCoverState(hlsOutputDir, relPath);
          }
          const mediaSummary = await getMediaSummary(filePath);
          const baseMovie = {
            name, 
            path: relPath, 
            folder: subDir.replace(/\\/g, '/'), 
            isTranscoded,
            ...coverState,
            ...mediaSummary
          };
          const displayMetadata = getMovieDisplayMetadata(baseMovie, metadata, episodeIndex);
          episodeIndex++;
          existingPaths.add(relPath);
          folderEpisodeCounts.set(baseMovie.folder, episodeIndex);

          movies.push({
            ...baseMovie,
            ...displayMetadata
          });
        }
      }
      if (!subDir && options.includeHlsOnly !== false) {
        const hlsOnlyMovies = await scanHlsOnlyMovies(
          hlsOutputDir,
          existingPaths,
          metadata,
          folderEpisodeCounts
        );
        movies = movies.concat(hlsOnlyMovies);
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
        
        const langCode = normalizeLanguageCode(getTagValue(tags, ['language', 'LANGUAGE']));
        const language = getLanguageName(langCode);
        const title = getTagValue(tags, ['title', 'TITLE']);
        
        const streamInfo = {
          index: stream.index,
          codec: stream.codec_name,
          codecProfile: stream.profile || '',
          codecTag: stream.codec_tag_string || '',
          level: stream.level,
          bitRate: stream.bit_rate,
          language: language,
          languageCode: langCode,
          title,
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
          streamInfo.channelLayout = stream.channel_layout || '';
          streamInfo.displayTitle = isUsefulAudioTitle(streamInfo.title, language)
            ? streamInfo.title
            : buildAudioFallbackTitle(stream, language, disposition);
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
function getAssociatedHlsPaths(hlsOutputDir, relPath) {
  const hlsPath = path.join(hlsOutputDir, relPath);
  const parentDir = path.dirname(hlsPath);
  const outputName = path.basename(hlsPath);
  const paths = [hlsPath];

  if (!fs.existsSync(parentDir)) return paths;

  const entries = fs.readdirSync(parentDir, { withFileTypes: true });
  for (const entry of entries) {
    const isStagingOutput = (
      entry.name.startsWith(`${outputName}.tmp-`) ||
      entry.name.startsWith(`${outputName}.copy-`)
    );

    if (isStagingOutput) {
      paths.push(path.join(parentDir, entry.name));
    }
  }

  return paths;
}

async function deleteMedia(relPath, moviesDir, hlsOutputDir, options = {}) {
  const { deleteOriginal = false } = options;
  
  // 1. Delete HLS data
  const hlsPaths = getAssociatedHlsPaths(hlsOutputDir, relPath);
  for (const hlsPath of hlsPaths) {
    if (fs.existsSync(hlsPath)) {
      console.log(`[Media] Deleting HLS data: ${hlsPath}`);
      fs.rmSync(hlsPath, { recursive: true, force: true });
    }
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
