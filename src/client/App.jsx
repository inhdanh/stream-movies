import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppBar,
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemAvatar,
  ListItemButton,
  ListItemText,
  LinearProgress,
  Paper,
  Skeleton,
  Snackbar,
  Stack,
  TextField,
  Toolbar,
  Tooltip,
  Typography
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlined';
import FolderIcon from '@mui/icons-material/Folder';
import ImageSearchIcon from '@mui/icons-material/ImageSearch';
import LinkIcon from '@mui/icons-material/Link';
import MovieFilterIcon from '@mui/icons-material/MovieFilter';
import SaveIcon from '@mui/icons-material/Save';
import VideoLibraryIcon from '@mui/icons-material/VideoLibrary';
import {
  deleteMovies,
  fetchAacTranscodeStatus,
  fetchMovies,
  fetchProgress,
  generateCover,
  saveMetadata,
  saveProgress,
  startAacTranscode,
  uploadCover
} from './api.js';

const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const COVER_LIMIT_BYTES = 10 * 1024 * 1024;

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getStatusLabel(movie) {
  return movie.link ? 'DIRECT' : 'MISSING';
}

function getStatusColor(movie) {
  return movie.link ? 'success' : 'error';
}

function getStatusIcon(movie) {
  return movie.link ? <CheckCircleIcon /> : <ErrorOutlineIcon />;
}

function getSourceResolution(movie) {
  const width = Number(movie?.sourceWidth);
  const height = Number(movie?.sourceHeight);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return null;
  }

  return { width, height };
}

function SectionCard({ title, action, children, sx }) {
  return (
    <Card variant="outlined" sx={{ overflow: 'hidden', ...sx }}>
      <Box
        sx={{
          alignItems: 'center',
          bgcolor: 'background.paper',
          borderBottom: 1,
          borderColor: 'divider',
          display: 'flex',
          justifyContent: 'space-between',
          minHeight: 48,
          px: 2
        }}
      >
        <Typography variant="subtitle2" sx={{ fontWeight: 800, letterSpacing: 0.2 }}>
          {title}
        </Typography>
        {action}
      </Box>
      {children}
    </Card>
  );
}

function MovieThumb({ coverUrl, generating, version }) {
  return (
    <Avatar
      variant="rounded"
      sx={{
        bgcolor: 'grey.900',
        border: 1,
        borderColor: 'divider',
        color: 'primary.light',
        fontSize: 11,
        fontWeight: 900,
        height: 46,
        width: 72
      }}
    >
      {generating ? (
        <CircularProgress color="inherit" size={18} />
      ) : coverUrl ? (
        <Box
          alt=""
          component="img"
          src={`${coverUrl}?v=${version || 0}`}
          sx={{ height: '100%', objectFit: 'cover', width: '100%' }}
        />
      ) : (
        'STV'
      )}
    </Avatar>
  );
}

function MovieList({ coverVersions, movies, selectedPath, selectedPaths, loading, onSelect, onToggleSelect }) {
  if (loading) {
    return (
      <Stack spacing={1.25} sx={{ p: 1.5 }}>
        {[0, 1, 2, 3, 4].map(item => (
          <Skeleton animation="wave" height={66} key={item} variant="rounded" />
        ))}
      </Stack>
    );
  }

  if (movies.length === 0) {
    return (
      <Box sx={{ display: 'grid', minHeight: 280, placeItems: 'center', px: 3, textAlign: 'center' }}>
        <Stack spacing={1.5} sx={{ alignItems: 'center' }}>
          <Avatar sx={{ bgcolor: 'action.selected', color: 'text.secondary', height: 64, width: 64 }}>
            <FolderIcon />
          </Avatar>
          <Typography variant="subtitle1">No movies found</Typography>
          <Typography color="text.secondary" variant="body2">
            D:/Movies is empty or unavailable.
          </Typography>
        </Stack>
      </Box>
    );
  }

  return (
    <List disablePadding sx={{ maxHeight: { md: 642, xs: 520 }, overflowY: 'auto', p: 1 }}>
      {movies.map(movie => {
        const selected = selectedPath === movie.path;
        const checked = selectedPaths.has(movie.path);
        const coverUrl = movie.coverUrl || null;

        return (
          <ListItem
            disablePadding
            key={movie.path}
            secondaryAction={
              <Chip
                color={getStatusColor(movie)}
                icon={getStatusIcon(movie)}
                label={getStatusLabel(movie)}
                size="small"
                sx={{ minWidth: 78 }}
                variant="filled"
              />
            }
            sx={{ mb: 0.75 }}
          >
            <Paper
              variant="outlined"
              sx={{
                bgcolor: selected ? 'action.selected' : 'background.default',
                borderColor: selected ? 'primary.main' : 'divider',
                overflow: 'hidden',
                width: '100%'
              }}
            >
              <ListItemButton onClick={() => onSelect(movie.path)} selected={selected} sx={{ gap: 1, pr: 11 }}>
                <Checkbox
                  checked={checked}
                  edge="start"
                  inputProps={{ 'aria-label': `Select ${movie.displayName || movie.name}` }}
                  onChange={event => {
                    event.stopPropagation();
                    onToggleSelect(movie.path);
                  }}
                  onClick={event => event.stopPropagation()}
                  size="small"
                />
                <ListItemAvatar sx={{ minWidth: 82 }}>
                  <MovieThumb coverUrl={coverUrl} generating={movie.coverGenerating} version={coverVersions[coverUrl]} />
                </ListItemAvatar>
                <ListItemText
                  primary={movie.displayName || movie.name}
                  primaryTypographyProps={{ fontWeight: 800, noWrap: true, variant: 'body2' }}
                  secondary={
                    <Stack direction="row" spacing={1.25} sx={{ minWidth: 0 }}>
                      <Typography color="text.secondary" noWrap variant="caption">
                        {movie.folder || 'Root'}
                      </Typography>
                      <Typography color="text.secondary" variant="caption">
                        {formatDuration(movie.durationSeconds)}
                      </Typography>
                      {movie.coverGenerating ? (
                        <Typography color="primary.light" variant="caption">
                          Auto cover
                        </Typography>
                      ) : null}
                    </Stack>
                  }
                />
              </ListItemButton>
            </Paper>
          </ListItem>
        );
      })}
    </List>
  );
}

function MetadataEditor({ movie, onSaved }) {
  const [title, setTitle] = useState('');
  const [episodeStart, setEpisodeStart] = useState(1);
  const [status, setStatus] = useState('');
  const [statusType, setStatusType] = useState('info');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTitle(movie?.title || '');
    setEpisodeStart(movie?.episodeStart || 1);
    setStatus('');
    setStatusType('info');
  }, [movie]);

  if (!movie) return null;

  const isSeries = movie.metadataScope === 'series';

  async function handleSave() {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setStatus('Title is required.');
      setStatusType('error');
      return;
    }

    const payload = { title: cleanTitle };
    if (isSeries) {
      const parsedEpisodeStart = Number.parseInt(episodeStart, 10);
      if (!Number.isFinite(parsedEpisodeStart) || parsedEpisodeStart < 1) {
        setStatus('Episode start must be 1 or higher.');
        setStatusType('error');
        return;
      }
      payload.episodeStart = parsedEpisodeStart;
    }

    setSaving(true);
    setStatus('Saving...');
    setStatusType('info');
    try {
      await saveMetadata(movie.path, payload);
      setStatus('Metadata saved.');
      setStatusType('success');
      await onSaved(movie.path);
    } catch (error) {
      setStatus(error.message || 'Save failed.');
      setStatusType('error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack spacing={1.25}>
      <Box
        sx={{
          alignItems: 'flex-start',
          display: 'grid',
          gap: 1.25,
          gridTemplateColumns: { sm: isSeries ? '1fr 142px auto' : '1fr auto', xs: '1fr' }
        }}
      >
        <TextField
          fullWidth
          inputProps={{ maxLength: 160 }}
          label={isSeries ? 'Series title' : 'Display title'}
          onChange={event => setTitle(event.target.value)}
          size="small"
          value={title}
        />
        {isSeries ? (
          <TextField
            inputProps={{ min: 1, step: 1 }}
            label="Episode start"
            onChange={event => setEpisodeStart(event.target.value)}
            size="small"
            type="number"
            value={episodeStart}
          />
        ) : null}
        <Button disabled={saving} onClick={handleSave} startIcon={saving ? <CircularProgress size={16} /> : <SaveIcon />} variant="contained">
          {saving ? 'Saving' : 'Save'}
        </Button>
      </Box>
      {status ? (
        <Alert severity={statusType} variant="outlined">
          {status}
        </Alert>
      ) : null}
    </Stack>
  );
}

function CoverUploader({ movie, onUploaded }) {
  const inputRef = useRef(null);
  const [status, setStatus] = useState('');
  const [statusType, setStatusType] = useState('info');
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    setStatus('');
    setStatusType('info');
  }, [movie?.path]);

  if (!movie) return null;

  async function handleFile(file) {
    if (!file) return;
    if (!COVER_TYPES.includes(file.type)) {
      setStatus('Only JPEG, PNG, or WebP images are supported.');
      setStatusType('error');
      return;
    }
    if (file.size > COVER_LIMIT_BYTES) {
      setStatus('Cover image must be 10MB or smaller.');
      setStatusType('error');
      return;
    }

    setUploading(true);
    setStatus('Uploading...');
    setStatusType('info');
    try {
      const result = await uploadCover(movie.path, file);
      setStatus('Cover updated.');
      setStatusType('success');
      await onUploaded(movie.path, result.coverUrl || null);
    } catch (error) {
      setStatus(error.message || 'Upload failed.');
      setStatusType('error');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function handleGenerate() {
    setGenerating(true);
    setStatus('Generating cover...');
    setStatusType('info');
    try {
      const result = await generateCover(movie.path);
      setStatus('Cover generated.');
      setStatusType('success');
      await onUploaded(movie.path, result.coverUrl || null);
    } catch (error) {
      setStatus(error.message || 'Generate cover failed.');
      setStatusType('error');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          accept={COVER_TYPES.join(',')}
          hidden
          onChange={event => handleFile(event.target.files?.[0])}
          ref={inputRef}
          type="file"
        />
        <Button
          disabled={uploading || generating || !movie.link}
          onClick={handleGenerate}
          startIcon={generating ? <CircularProgress size={16} /> : <ImageSearchIcon />}
          variant="contained"
        >
          {generating ? 'Generating' : 'Generate Cover'}
        </Button>
        <Button
          disabled={uploading || generating}
          onClick={() => inputRef.current?.click()}
          startIcon={uploading ? <CircularProgress size={16} /> : <CloudUploadIcon />}
          variant="outlined"
        >
          {uploading ? 'Uploading' : 'Upload Cover'}
        </Button>
        <Typography color="text.secondary" variant="caption">
          JPEG, PNG, WebP up to 10MB
        </Typography>
      </Stack>
      {status ? (
        <Alert severity={statusType} variant="outlined">
          {status}
        </Alert>
      ) : null}
    </Stack>
  );
}

function DirectPlaybackPanel({ movie, onCompatibleCreated }) {
  const [copyState, setCopyState] = useState('');
  const [actionState, setActionState] = useState('');
  const [actionStateType, setActionStateType] = useState('info');
  const [aacJob, setAacJob] = useState(null);
  const [startingAac, setStartingAac] = useState(false);
  const completedAacOutputRef = useRef('');

  const sourceResolution = useMemo(() => getSourceResolution(movie), [movie]);
  const aacBusy = ['queued', 'running'].includes(aacJob?.status);
  const aacProgress = Math.max(0, Math.min(100, Math.round(aacJob?.progress || 0)));

  useEffect(() => {
    setCopyState('');
    setActionState('');
    setActionStateType('info');
    setAacJob(null);
    completedAacOutputRef.current = '';
  }, [movie?.path]);

  useEffect(() => {
    if (!movie?.path) return undefined;

    let disposed = false;
    fetchAacTranscodeStatus(movie.path)
      .then(job => {
        if (!disposed && job?.status !== 'idle') setAacJob(job);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
    };
  }, [movie?.path]);

  useEffect(() => {
    if (!movie?.path || !aacBusy) return undefined;

    const timer = window.setInterval(async () => {
      try {
        const job = await fetchAacTranscodeStatus(movie.path);
        setAacJob(job);

        if (job.status === 'done' && job.outputPath && completedAacOutputRef.current !== job.outputPath) {
          completedAacOutputRef.current = job.outputPath;
          await onCompatibleCreated(job.outputPath);
        }
      } catch (error) {
        setAacJob(current => ({
          ...(current || {}),
          error: error.message || 'Failed to read AAC transcode progress.',
          status: 'failed'
        }));
      }
    }, 2000);

    return () => window.clearInterval(timer);
  }, [aacBusy, movie?.path, onCompatibleCreated]);

  if (!movie) return null;

  async function handleCopy() {
    const url = movie.link;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = url;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopyState('Copied.');
    } catch {
      setCopyState('Copy failed.');
    }
  }

  async function handleStartAacTranscode() {
    setStartingAac(true);
    setActionState('Starting AAC transcode...');
    setActionStateType('info');

    try {
      const result = await startAacTranscode(movie.path);
      const job = result.job || result;
      setAacJob(job);

      if (job.status === 'skipped') {
        setActionState('Audio is already AAC.');
        setActionStateType('success');
      } else if (job.status === 'done' && job.outputPath) {
        setActionState('AAC transcode is complete.');
        setActionStateType('success');
        await onCompatibleCreated(job.outputPath);
      } else {
        setActionState('AAC transcode started.');
        setActionStateType('info');
      }
    } catch (error) {
      setActionState(error.message || 'Start AAC transcode failed.');
      setActionStateType('error');
    } finally {
      setStartingAac(false);
    }
  }

  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography color="text.secondary" sx={{ mb: 0.75 }} variant="caption">
          Direct playback
        </Typography>
        {sourceResolution ? (
          <Typography color="text.secondary" sx={{ display: 'block', mb: 0.5 }} variant="caption">
            Source: {sourceResolution.width}x{sourceResolution.height}
          </Typography>
        ) : null}
        <Chip label="Original file" size="small" variant="outlined" />
      </Box>
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
        <Button onClick={handleCopy} startIcon={<ContentCopyIcon />} variant="outlined">
          Copy Direct URL
        </Button>
        <Button
          disabled={aacBusy || startingAac || !movie.link}
          onClick={handleStartAacTranscode}
          startIcon={(startingAac || aacBusy) ? <CircularProgress size={16} /> : <VideoLibraryIcon />}
          variant="outlined"
        >
          {aacBusy ? `AAC ${aacProgress}%` : 'Transcode AAC'}
        </Button>
      </Stack>
      {aacJob && aacJob.status !== 'idle' ? (
        <Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.75 }}>
            <Typography color="text.secondary" variant="caption">
              AAC transcode: {aacJob.status}
            </Typography>
            {aacJob.durationSeconds ? (
              <Typography color="text.secondary" variant="caption">
                {formatDuration(aacJob.timeSeconds || 0)} / {formatDuration(aacJob.durationSeconds)}
              </Typography>
            ) : null}
          </Stack>
          <LinearProgress
            color={aacJob.status === 'failed' ? 'error' : 'primary'}
            variant={aacBusy || aacProgress > 0 ? 'determinate' : 'indeterminate'}
            value={aacProgress}
          />
          {aacJob.outputPath ? (
            <Typography color="text.secondary" sx={{ display: 'block', mt: 0.75 }} variant="caption">
              Output: {aacJob.outputPath}
            </Typography>
          ) : null}
          {aacJob.error ? (
            <Typography color="error" sx={{ display: 'block', mt: 0.75 }} variant="caption">
              {aacJob.error}
            </Typography>
          ) : null}
        </Box>
      ) : null}
      {copyState ? (
        <Alert severity={copyState === 'Copied.' ? 'success' : 'error'} variant="outlined">
          {copyState}
        </Alert>
      ) : null}
      {actionState ? (
        <Alert severity={actionStateType} variant="outlined">
          {actionState}
        </Alert>
      ) : null}
    </Stack>
  );
}

function Player({ movie, active }) {
  const videoRef = useRef(null);
  const lastSavedRef = useRef(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!movie || !active || !video) return undefined;

    const source = movie.link;
    let disposed = false;

    async function restoreProgress() {
      try {
        const progress = await fetchProgress(movie.path);
        if (!disposed && progress?.seconds > 5) {
          video.currentTime = progress.seconds;
          lastSavedRef.current = progress.seconds;
        }
      } catch (error) {
        console.warn('Failed to restore progress', error);
      }
    }

    video.src = source;
    video.addEventListener('loadedmetadata', restoreProgress, { once: true });

    const interval = window.setInterval(() => {
      if (video.paused || video.currentTime <= 0) return;
      if (Math.abs(video.currentTime - lastSavedRef.current) <= 5) return;
      saveProgress(movie.path, video.currentTime, video.duration).catch(error => {
        console.warn('Failed to save progress', error);
      });
      lastSavedRef.current = video.currentTime;
    }, 5000);

    return () => {
      disposed = true;
      window.clearInterval(interval);
      video.pause();
      video.removeEventListener('loadedmetadata', restoreProgress);
      video.removeAttribute('src');
      video.load();
    };
  }, [movie, active]);

  if (!movie || !active) return null;

  return (
    <Card variant="outlined" sx={{ overflow: 'hidden', position: 'relative' }}>
      <Box component="video" controls crossOrigin="anonymous" preload="none" ref={videoRef} sx={{ bgcolor: '#000', display: 'block', width: '100%' }} />
      <Chip
        icon={<VideoLibraryIcon />}
        label="Direct Player"
        size="small"
        sx={{ left: 12, position: 'absolute', top: 12 }}
        variant="filled"
      />
    </Card>
  );
}

function DetailsPanel({ coverVersions, movie, onDeleteRequest, onReload }) {
  if (!movie) {
    return (
      <SectionCard title="Episode Details" sx={{ minHeight: { md: 642, xs: 360 } }}>
        <Box sx={{ display: 'grid', minHeight: 560, placeItems: 'center', px: 4, textAlign: 'center' }}>
          <Stack spacing={1.5} sx={{ alignItems: 'center' }}>
            <Avatar sx={{ bgcolor: 'action.selected', color: 'text.secondary', height: 76, width: 76 }}>
              <MovieFilterIcon fontSize="large" />
            </Avatar>
            <Typography variant="h6">Select a movie</Typography>
            <Typography color="text.secondary" variant="body2">
              View details, edit metadata, upload a cover, or play the original file directly.
            </Typography>
          </Stack>
        </Box>
      </SectionCard>
    );
  }

  const coverUrl = movie.coverUrl || null;
  return (
    <SectionCard
      action={
        <Chip
          color={getStatusColor(movie)}
          icon={getStatusIcon(movie)}
          label={getStatusLabel(movie)}
          size="small"
          variant="filled"
        />
      }
      title="Episode Details"
      sx={{ minHeight: { md: 642, xs: 0 } }}
    >
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ overflowWrap: 'anywhere' }} variant="h5">
                {movie.displayName || movie.name}
              </Typography>
              <Typography color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }} variant="caption">
                {movie.path}
              </Typography>
            </Box>
          </Stack>

          <Box
            sx={{
              alignItems: 'center',
              aspectRatio: '16 / 6.3',
              bgcolor: 'grey.950',
              border: 1,
              borderColor: 'divider',
              borderRadius: 1,
              color: 'text.secondary',
              display: 'flex',
              justifyContent: 'center',
              overflow: 'hidden'
            }}
          >
            {coverUrl ? (
              <Box
                alt=""
                component="img"
                src={`${coverUrl}?v=${coverVersions[coverUrl] || 0}`}
                sx={{ height: '100%', objectFit: 'cover', width: '100%' }}
              />
            ) : movie.coverGenerating ? (
              <Stack spacing={1} sx={{ alignItems: 'center' }}>
                <CircularProgress color="inherit" size={22} />
                <Typography variant="body2">Generating cover...</Typography>
              </Stack>
            ) : (
              <Typography variant="body2">No cover</Typography>
            )}
          </Box>

          <CoverUploader movie={movie} onUploaded={onReload} />
          <Divider />
          <MetadataEditor movie={movie} onSaved={onReload} />
          <Divider />
          <DirectPlaybackPanel movie={movie} onCompatibleCreated={onReload} />
          <Divider />
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
            <Button color="error" onClick={() => onDeleteRequest([movie.path], false)} startIcon={<DeleteOutlineIcon />} variant="outlined">
              Delete Generated Assets
            </Button>
            <Button color="error" onClick={() => onDeleteRequest([movie.path], true)} startIcon={<DeleteForeverIcon />} variant="contained">
              Delete Movie File
            </Button>
          </Stack>

          <Paper
            variant="outlined"
            sx={{
              alignItems: 'center',
              display: 'flex',
              gap: 1,
              minWidth: 0,
              p: 1.25
            }}
          >
            <LinkIcon color="primary" fontSize="small" />
            <Typography color="text.secondary" noWrap variant="caption">
              {movie.link}
            </Typography>
          </Paper>
        </Stack>
      </CardContent>
    </SectionCard>
  );
}

function BulkBar({ selectedPaths, onClear, onDeleteRequest }) {
  if (selectedPaths.size === 0) return null;
  const paths = Array.from(selectedPaths);

  return (
    <Paper
      elevation={16}
      sx={{
        alignItems: { sm: 'center', xs: 'stretch' },
        border: 1,
        borderColor: 'primary.dark',
        bottom: 24,
        display: 'flex',
        flexDirection: { sm: 'row', xs: 'column' },
        gap: 1,
        left: '50%',
        maxWidth: 'calc(100% - 32px)',
        p: 1.25,
        position: 'fixed',
        transform: 'translateX(-50%)',
        width: { sm: 'auto', xs: 'calc(100% - 32px)' },
        zIndex: theme => theme.zIndex.snackbar
      }}
    >
      <Typography sx={{ px: 1.25, whiteSpace: 'nowrap' }} variant="body2">
        <Box component="strong" sx={{ color: 'primary.light', fontSize: 18 }}>
          {selectedPaths.size}
        </Box>{' '}
        items selected
      </Typography>
      <Divider flexItem orientation="vertical" sx={{ display: { sm: 'block', xs: 'none' } }} />
      <Button color="error" onClick={() => onDeleteRequest(paths, false)} startIcon={<DeleteOutlineIcon />} variant="outlined">
        Delete Generated Assets
      </Button>
      <Button color="error" onClick={() => onDeleteRequest(paths, true)} startIcon={<DeleteForeverIcon />} variant="contained">
        Delete Movie Files
      </Button>
      <Button onClick={onClear} variant="text">
        Cancel
      </Button>
    </Paper>
  );
}

export default function App() {
  const [movies, setMovies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedPath, setSelectedPath] = useState('');
  const [selectedPaths, setSelectedPaths] = useState(() => new Set());
  const [coverVersions, setCoverVersions] = useState({});
  const [notice, setNotice] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const selectedMovie = useMemo(
    () => movies.find(movie => movie.path === selectedPath) || null,
    [movies, selectedPath]
  );

  const loadMovies = useCallback(async (preferredPath, options = {}) => {
    if (!options.silent) setLoading(true);
    try {
      const nextMovies = await fetchMovies();
      setMovies(nextMovies);
      setSelectedPath(current => {
        const targetPath = preferredPath || current;
        if (targetPath && nextMovies.some(movie => movie.path === targetPath)) return targetPath;
        return nextMovies[0]?.path || '';
      });
      setNotice('');
    } catch (error) {
      setNotice(error.message || 'Failed to load movies.');
    } finally {
      if (!options.silent) setLoading(false);
    }
  }, []);

  const reloadMoviesAndBustCover = useCallback(
    async (preferredPath, coverUrl) => {
      await loadMovies(preferredPath);
      setCoverVersions(current => ({
        ...current,
        [preferredPath]: Date.now(),
        ...(coverUrl ? { [coverUrl]: Date.now() } : {})
      }));
    },
    [loadMovies]
  );

  useEffect(() => {
    loadMovies();
  }, [loadMovies]);

  useEffect(() => {
    if (!movies.some(movie => movie.coverGenerating)) return undefined;
    const timer = window.setTimeout(() => {
      loadMovies(selectedPath, { silent: true });
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [loadMovies, movies, selectedPath]);

  function toggleSelected(path) {
    setSelectedPaths(current => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function requestDelete(paths, deleteOriginal) {
    setPendingDelete({ paths, deleteOriginal });
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const { paths, deleteOriginal } = pendingDelete;
    setDeleteBusy(true);
    try {
      await deleteMovies(paths, deleteOriginal);
      setSelectedPaths(new Set());
      if (paths.includes(selectedPath)) setSelectedPath('');
      setNotice(`Deleted ${paths.length} item(s).`);
      setPendingDelete(null);
      await loadMovies();
    } catch (error) {
      setNotice(error.message || 'Delete failed.');
    } finally {
      setDeleteBusy(false);
    }
  }

  const readyForPlayer = Boolean(selectedMovie?.link);
  const deleteLabel = pendingDelete?.deleteOriginal ? 'movie files and generated assets' : 'generated assets';

  return (
    <Box sx={{ minHeight: '100vh', pb: 12 }}>
      <AppBar color="transparent" elevation={0} position="sticky" sx={{ backdropFilter: 'blur(18px)', borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar sx={{ gap: 2, mx: 'auto', width: 'min(1220px, 100%)' }}>
          <Avatar
            variant="rounded"
            sx={{
              bgcolor: 'primary.main',
              color: 'primary.contrastText',
              fontSize: 18,
              fontStyle: 'italic',
              fontWeight: 900,
              height: 42,
              width: 42
            }}
          >
            STV
          </Avatar>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography noWrap variant="h6">
              StreamTV CMS Admin
            </Typography>
            <Typography color="text.secondary" noWrap variant="caption">
              Direct MKV streaming dashboard
            </Typography>
          </Box>
        </Toolbar>
      </AppBar>

      <Box component="main" sx={{ mx: 'auto', p: { md: 3, xs: 1.5 }, width: 'min(1220px, 100%)' }}>
        <Stack spacing={2}>
          <Paper
            variant="outlined"
            sx={{
              alignItems: { sm: 'center', xs: 'flex-start' },
              display: 'flex',
              flexDirection: { sm: 'row', xs: 'column' },
              gap: 1.5,
              justifyContent: 'space-between',
              p: 1.5
            }}
          >
            <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', minWidth: 0 }}>
              <Avatar sx={{ bgcolor: 'action.selected', color: 'primary.light' }}>
                <FolderIcon />
              </Avatar>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="subtitle2">Local Movies</Typography>
                <Typography color="text.secondary" noWrap variant="caption">
                  D:/Movies
                </Typography>
              </Box>
            </Stack>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Chip label={`${movies.length} items`} size="small" variant="outlined" />
              <Chip
                color="success"
                label={`${movies.filter(movie => movie.link).length} playable`}
                size="small"
                variant="outlined"
              />
            </Stack>
          </Paper>

          <Box
            sx={{
              alignItems: 'flex-start',
              display: 'grid',
              gap: 2,
              gridTemplateColumns: { lg: 'minmax(0, 0.95fr) minmax(0, 1.05fr)', xs: '1fr' }
            }}
          >
            <SectionCard
              action={
                <Chip
                  icon={<VideoLibraryIcon />}
                  label={loading ? 'Loading' : `${movies.length} files`}
                  size="small"
                  variant="outlined"
                />
              }
              title="File Manager"
            >
              <MovieList
                coverVersions={coverVersions}
                loading={loading}
                movies={movies}
                onSelect={setSelectedPath}
                onToggleSelect={toggleSelected}
                selectedPath={selectedPath}
                selectedPaths={selectedPaths}
              />
            </SectionCard>

            <Stack spacing={2}>
              <DetailsPanel
                coverVersions={coverVersions}
                movie={selectedMovie}
                onDeleteRequest={requestDelete}
                onReload={reloadMoviesAndBustCover}
              />
              <Player active={Boolean(readyForPlayer)} movie={selectedMovie} />
            </Stack>
          </Box>
        </Stack>
      </Box>

      <BulkBar onClear={() => setSelectedPaths(new Set())} onDeleteRequest={requestDelete} selectedPaths={selectedPaths} />

      <Dialog onClose={() => (!deleteBusy ? setPendingDelete(null) : null)} open={Boolean(pendingDelete)}>
        <DialogTitle>Confirm delete</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Delete {deleteLabel} for {pendingDelete?.paths.length || 0} item(s)? This action cannot be undone from the CMS.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button disabled={deleteBusy} onClick={() => setPendingDelete(null)}>
            Cancel
          </Button>
          <Button
            color="error"
            disabled={deleteBusy}
            onClick={confirmDelete}
            startIcon={deleteBusy ? <CircularProgress size={16} /> : <DeleteForeverIcon />}
            variant="contained"
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        anchorOrigin={{ horizontal: 'right', vertical: 'top' }}
        autoHideDuration={5000}
        onClose={() => setNotice('')}
        open={Boolean(notice)}
      >
        <Alert onClose={() => setNotice('')} severity={notice.toLowerCase().includes('failed') ? 'error' : 'info'} variant="filled">
          {notice}
        </Alert>
      </Snackbar>
    </Box>
  );
}
