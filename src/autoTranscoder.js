const fs = require('fs');
const path = require('path');
const { scanMovies } = require('./media');
const { transcodeToHls, getTranscodeStatus } = require('./transcoder');

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
      // Start transcoding. transcodeToHls returns a jobId and runs in background.
      // We need to wait for it to finish before processing the next one in the queue.
      // However, transcodeToHls doesn't return a promise that resolves when finished.
      // We need to poll for status or modify transcodeToHls.
      
      // For now, let's wait by polling status.
      await transcodeToHls(fullPath, this.moviesDir, this.hlsOutputDir);
      
      this.waitForCompletion(moviePath);
    } catch (error) {
      console.error(`[AutoTranscoder] Error starting transcode for ${moviePath}:`, error);
      this.isProcessing = false;
      this.processQueue(); // Try next one
    }
  }

  waitForCompletion(moviePath) {
    const checkInterval = setInterval(() => {
      const status = getTranscodeStatus(moviePath, this.hlsOutputDir);
      
      if (status.status === 'completed') {
        console.log(`[AutoTranscoder] Completed: ${moviePath}`);
        clearInterval(checkInterval);
        this.isProcessing = false;
        this.processQueue();
      } else if (status.status === 'error') {
        console.error(`[AutoTranscoder] Error transcoding ${moviePath}: ${status.error}`);
        clearInterval(checkInterval);
        this.isProcessing = false;
        this.processQueue();
      }
      // If still processing, just wait for next interval
    }, 5000); // Check every 5 seconds
  }
}

module.exports = AutoTranscoder;
