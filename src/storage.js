const fs = require('fs');
const path = require('path');

const STORAGE_FILE = path.join(__dirname, '../progress.json');

function loadProgress() {
  if (!fs.existsSync(STORAGE_FILE)) {
    return {};
  }
  try {
    const data = fs.readFileSync(STORAGE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading progress:', error);
    return {};
  }
}

function saveProgress(filename, seconds) {
  const progress = loadProgress();
  progress[filename] = {
    seconds,
    updatedAt: new Date().toISOString()
  };
  try {
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(progress, null, 2));
  } catch (error) {
    console.error('Error saving progress:', error);
  }
}

function getProgress(filename) {
  const progress = loadProgress();
  return progress[filename] || { seconds: 0 };
}

module.exports = {
  saveProgress,
  getProgress
};
