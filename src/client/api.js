export const baseUrl = window.location.origin;

export function encodeMoviePath(path) {
  return encodeURIComponent(path);
}

export function encodeStreamPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function parseJsonResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || data.details || `Request failed with ${response.status}`);
  }
  return data;
}

export async function fetchMovies() {
  const data = await fetch('/movies').then(parseJsonResponse);
  return data.movies || [];
}

export async function saveMetadata(path, payload) {
  return fetch(`/movies/${encodeMoviePath(path)}/metadata`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(parseJsonResponse);
}

export async function uploadCover(path, file) {
  return fetch(`/movies/${encodeMoviePath(path)}/cover`, {
    method: 'POST',
    headers: { 'Content-Type': file.type },
    body: file
  }).then(parseJsonResponse);
}

export async function startTranscode(path) {
  return fetch(`/movies/${encodeMoviePath(path)}/transcode`, {
    method: 'POST'
  }).then(parseJsonResponse);
}

export async function fetchTranscodeStatus(path) {
  return fetch(`/movies/${encodeMoviePath(path)}/transcode/status`).then(parseJsonResponse);
}

export async function startAutoTranscode() {
  return fetch('/movies/auto-transcode', {
    method: 'POST'
  }).then(parseJsonResponse);
}

export async function deleteMovies(paths, deleteOriginal) {
  return fetch('/movies', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths, deleteOriginal })
  }).then(parseJsonResponse);
}

export async function fetchProgress(path) {
  return fetch(`/movies/${encodeMoviePath(path)}/progress`).then(parseJsonResponse);
}

export async function saveProgress(path, seconds, duration) {
  return fetch(`/movies/${encodeMoviePath(path)}/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seconds, duration })
  }).then(parseJsonResponse);
}

export function getM3u8Url(path) {
  return `${baseUrl}/stream/${encodeStreamPath(path)}/master.m3u8`;
}

export function getCoverUrl(path) {
  return `${baseUrl}/stream/${encodeStreamPath(path)}/cover.jpg`;
}
