const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

// Allowed video extensions
const VIDEO_EXTENSIONS = ['.mkv', '.mp4', '.avi', '.mov', '.wmv'];

/**
 * Scan directory for movies
 */
async function scanMovies(dirPath) {
  return new Promise((resolve, reject) => {
    fs.readdir(dirPath, { withFileTypes: true }, (err, files) => {
      if (err) {
        if (err.code === 'ENOENT') {
          return resolve([]); // Directory doesn't exist
        }
        return reject(err);
      }

      const movies = files
        .filter(dirent => dirent.isFile() && VIDEO_EXTENSIONS.includes(path.extname(dirent.name).toLowerCase()))
        .map(dirent => dirent.name);
      
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
        
        const streamInfo = {
          index: stream.index,
          codec: stream.codec_name,
          language: tags.language || tags.LANGUAGE || 'und',
          title: tags.title || tags.TITLE || '',
        };

        if (codecType === 'video') {
          // Sometimes videos have attached pictures (cover art) which are marked as video streams
          if (stream.disposition && stream.disposition.attached_pic === 1) {
             return;
          }
          streamInfo.width = stream.width;
          streamInfo.height = stream.height;
          info.video.push(streamInfo);
        } else if (codecType === 'audio') {
          streamInfo.channels = stream.channels;
          info.audio.push(streamInfo);
        } else if (codecType === 'subtitle') {
          info.subtitle.push(streamInfo);
        }
      });

      resolve(info);
    });
  });
}

module.exports = {
  scanMovies,
  getMediaInfo
};
