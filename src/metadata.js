const fs = require('fs');
const path = require('path');

const METADATA_FILE = path.join(__dirname, '../movie-metadata.json');

function emptyMetadata() {
  return {
    movies: {},
    series: {}
  };
}

function normalizeRelPath(relPath) {
  return String(relPath || '').replace(/\\/g, '/');
}

function loadMetadata() {
  if (!fs.existsSync(METADATA_FILE)) {
    return emptyMetadata();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
    return {
      movies: parsed.movies && typeof parsed.movies === 'object' ? parsed.movies : {},
      series: parsed.series && typeof parsed.series === 'object' ? parsed.series : {}
    };
  } catch (error) {
    console.error('Error loading movie metadata:', error);
    return emptyMetadata();
  }
}

function saveMetadata(metadata) {
  fs.writeFileSync(METADATA_FILE, JSON.stringify({
    movies: metadata.movies || {},
    series: metadata.series || {}
  }, null, 2));
}

function getMetadataTarget(relPath) {
  const normalizedPath = normalizeRelPath(relPath);
  const folder = path.dirname(normalizedPath).replace(/\\/g, '/');

  if (folder && folder !== '.') {
    return {
      scope: 'series',
      key: folder
    };
  }

  return {
    scope: 'movie',
    key: normalizedPath
  };
}

function getSeriesTitleFallback(seriesKey) {
  return path.basename(seriesKey.replace(/\\/g, '/')) || seriesKey;
}

function getDefaultMovieTitle(filename) {
  const ext = path.extname(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

function parseEpisodeStart(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function getMovieDisplayMetadata(movie, metadata, episodeIndex = 0) {
  const target = getMetadataTarget(movie.path);

  if (target.scope === 'series') {
    const series = metadata.series[target.key] || {};
    const title = String(series.title || '').trim() || getSeriesTitleFallback(target.key);
    const episodeStart = parseEpisodeStart(series.episodeStart);
    const episodeNumber = episodeStart + episodeIndex;

    return {
      metadataScope: 'series',
      metadataKey: target.key,
      title,
      episodeStart,
      episodeNumber,
      displayName: `${title} - Tập ${episodeNumber}`
    };
  }

  const storedMovie = metadata.movies[target.key] || {};
  const title = String(storedMovie.title || '').trim() || getDefaultMovieTitle(movie.name);

  return {
    metadataScope: 'movie',
    metadataKey: target.key,
    title,
    episodeStart: null,
    episodeNumber: null,
    displayName: title
  };
}

function updateMovieMetadata(relPath, patch) {
  const metadata = loadMetadata();
  const target = getMetadataTarget(relPath);
  const title = typeof patch.title === 'string' ? patch.title.trim() : '';

  if (!title) {
    const error = new Error('Movie title is required');
    error.statusCode = 400;
    throw error;
  }

  if (target.scope === 'series') {
    metadata.series[target.key] = {
      ...(metadata.series[target.key] || {}),
      title,
      episodeStart: parseEpisodeStart(patch.episodeStart)
    };
  } else {
    metadata.movies[target.key] = {
      ...(metadata.movies[target.key] || {}),
      title
    };
  }

  saveMetadata(metadata);
  return {
    scope: target.scope,
    key: target.key,
    metadata
  };
}

module.exports = {
  loadMetadata,
  updateMovieMetadata,
  getMovieDisplayMetadata,
  getMetadataTarget
};
