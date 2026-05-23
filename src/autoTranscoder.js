const path = require('path');
const { scanMovies } = require('./media');
const { transcodeToHls, waitForTranscode, getTranscodeStatus } = require('./transcoder');

class AutoTranscoder {
  constructor(moviesDir, hlsOutputDir) {
    this.moviesDir = moviesDir;
    this.hlsOutputDir = hlsOutputDir;
    this.queue = [];
    this.isProcessing = false;
    this.isScanning = false;
  }

  async scan() {
    if (this.isScanning) return;
    this.isScanning = true;
    
    try {
      console.log('[AutoTranscoder] Scanning for new movies...');
      const movies = await scanMovies(this.moviesDir, this.hlsOutputDir);
      
      const moviesToTranscode = movies.filter(movie => !movie.isTranscoded);
      
      for (const movie of moviesToTranscode) {
        // Check if already in queue
        if (!this.queue.includes(movie.path)) {
          // Double check status in case it's currently transcoding (from a previous job or manual trigger)
          const status = getTranscodeStatus(movie.path, this.hlsOutputDir);
          if (status.status === 'idle') {
            console.log(`[AutoTranscoder] Found movie to transcode: ${movie.name}`);
            this.queue.push(movie.path);
          }
        }
      }

      this.processQueue();
    } catch (error) {
      console.error('[AutoTranscoder] Error during scan:', error);
    } finally {
      this.isScanning = false;
    }
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    
    this.isProcessing = true;
    
    const moviePath = this.queue.shift();
    const fullPath = path.join(this.moviesDir, moviePath);
    
    console.log(`[AutoTranscoder] Starting auto-transcode for: ${moviePath}`);
    
    try {
      await transcodeToHls(fullPath, this.moviesDir, this.hlsOutputDir, { highestOnly: true });
      const status = await waitForTranscode(moviePath);

      if (status.status === 'completed') {
        console.log(`[AutoTranscoder] Completed: ${moviePath}`);
      } else if (status.status === 'error') {
        console.error(`[AutoTranscoder] Error transcoding ${moviePath}: ${status.error}`);
      }
    } catch (error) {
      console.error(`[AutoTranscoder] Error starting transcode for ${moviePath}:`, error);
    } finally {
      this.isProcessing = false;
      this.processQueue(); // Try next one
    }
  }
}

module.exports = AutoTranscoder;
