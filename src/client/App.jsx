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
  Tab,
  Tabs,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlined';
import FolderIcon from '@mui/icons-material/Folder';
import ImageSearchIcon from '@mui/icons-material/ImageSearch';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import LinkIcon from '@mui/icons-material/Link';
import MovieFilterIcon from '@mui/icons-material/MovieFilter';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import SaveIcon from '@mui/icons-material/Save';
import SearchIcon from '@mui/icons-material/Search';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import VideoLibraryIcon from '@mui/icons-material/VideoLibrary';
import VolumeUpOutlinedIcon from '@mui/icons-material/VolumeUpOutlined';
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
    <Card
      variant="outlined"
      sx={{
        bgcolor: 'rgba(16, 20, 43, 0.82)',
        borderColor: 'rgba(148, 163, 184, 0.22)',
        boxShadow: '0 20px 60px rgba(0, 0, 0, 0.18)',
        overflow: 'hidden',
        ...sx
      }}
    >
      <Box
        sx={{
          alignItems: 'center',
          display: 'flex',
          justifyContent: 'space-between',
          minHeight: 44,
          px: { sm: 2, xs: 1.5 },
          pt: 0.75
        }}
      >
        <Typography
          variant="subtitle2"
          sx={{
            alignItems: 'center',
            display: 'flex',
            fontWeight: 900,
            gap: 1,
            letterSpacing: 0
          }}
        >
          <Box component="span" sx={{ bgcolor: 'primary.main', borderRadius: 1, height: 18, width: 4 }} />
          {title}
        </Typography>
        {action}
      </Box>
      {children}
    </Card>
  );
}

function MovieList({ movies, selectedPath, selectedPaths, loading, onSelect, onToggleSelect }) {
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
    <List
      disablePadding
      sx={{
        maxHeight: { lg: 620, xs: 'calc(100vh - 268px)' },
        minHeight: { xs: 360, sm: 460 },
        overflowY: 'auto',
        p: { sm: 1, xs: 0.75 }
      }}
    >
      {movies.map(movie => {
        const selected = selectedPath === movie.path;
        const checked = selectedPaths.has(movie.path);

        return (
          <ListItem
            disablePadding
            key={movie.path}
            sx={{ mb: 0.75 }}
          >
            <Paper
              sx={{
                bgcolor: selected ? 'rgba(91, 43, 174, 0.35)' : 'rgba(15, 20, 45, 0.86)',
                border: '1px solid',
                borderColor: selected ? 'rgba(139, 92, 246, 0.82)' : 'rgba(148, 163, 184, 0.18)',
                borderRadius: 1,
                boxShadow: selected ? '0 0 0 1px rgba(139, 92, 246, 0.18), 0 14px 34px rgba(91, 43, 174, 0.22)' : 'none',
                overflow: 'hidden',
                width: '100%'
              }}
            >
              <ListItemButton
                onClick={() => onSelect(movie.path)}
                selected={selected}
                sx={{
                  alignItems: 'center',
                  display: 'grid',
                  gap: 1.25,
                  gridTemplateColumns: '28px minmax(0, 1fr) auto',
                  minHeight: 62,
                  p: 1,
                  position: 'relative'
                }}
              >
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
                  sx={{
                    display: selectedPaths.size > 0 ? 'inline-flex' : 'none',
                    p: 0.5,
                    position: 'absolute',
                    right: 28,
                    top: 14,
                    zIndex: 1
                  }}
                />
                <ListItemAvatar sx={{ minWidth: 28 }}>
                  <Avatar
                    variant="rounded"
                    sx={{
                      bgcolor: 'rgba(6, 182, 212, 0.16)',
                      color: 'secondary.main',
                      height: 28,
                      width: 28
                    }}
                  >
                    <PlayArrowIcon sx={{ fontSize: 18 }} />
                  </Avatar>
                </ListItemAvatar>
                <ListItemText
                  primary={movie.episodeNumber ? `Tập ${movie.episodeNumber}` : movie.displayName || movie.name}
                  primaryTypographyProps={{ fontWeight: 800, noWrap: true, variant: 'body2' }}
                  sx={{ minWidth: 0, my: 0 }}
                  secondary={
                    <Stack direction="row" spacing={1.25} sx={{ flexWrap: 'wrap', minWidth: 0, rowGap: 0 }}>
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
                <KeyboardArrowRightIcon color={selected ? 'secondary' : 'disabled'} fontSize="small" />
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
          display: 'grid',
          gap: 1.25,
          gridTemplateColumns: '1fr'
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
            fullWidth
            inputProps={{ min: 1, step: 1 }}
            label="Episode"
            onChange={event => setEpisodeStart(event.target.value)}
            size="small"
            type="number"
            value={episodeStart}
          />
        ) : null}
        <Button disabled={saving} onClick={handleSave} startIcon={saving ? <CircularProgress size={16} /> : <SaveIcon />} sx={{ justifySelf: 'start', width: { sm: 140, xs: '100%' } }} variant="outlined">
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
      <Stack direction={{ sm: 'row', xs: 'column' }} spacing={1} sx={{ alignItems: 'stretch' }}>
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
          sx={{ flex: 1 }}
          variant="contained"
        >
          {generating ? 'Generating' : 'Generate Cover'}
        </Button>
        <Button
          disabled={uploading || generating}
          onClick={() => inputRef.current?.click()}
          startIcon={uploading ? <CircularProgress size={16} /> : <CloudUploadIcon />}
          sx={{ flex: 1 }}
          variant="outlined"
        >
          {uploading ? 'Uploading' : 'Upload Cover'}
        </Button>
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
        <Typography sx={{ alignItems: 'center', color: 'text.primary', display: 'flex', fontWeight: 800, gap: 0.75, mb: 2 }} variant="body2">
          <VolumeUpOutlinedIcon color="secondary" sx={{ fontSize: 16 }} />
          Direct playback
        </Typography>
        {sourceResolution ? (
          <Typography color="text.secondary" sx={{ display: 'block', mb: 0.5 }} variant="caption">
            Source: {sourceResolution.width}x{sourceResolution.height}
          </Typography>
        ) : null}
        <Chip label="Original file" size="small" variant="outlined" />
      </Box>
      <Stack direction={{ sm: 'row', xs: 'column' }} spacing={1} sx={{ alignItems: { sm: 'center', xs: 'stretch' } }}>
        <Button onClick={handleCopy} startIcon={<ContentCopyIcon />} sx={{ width: { sm: 'auto', xs: '100%' } }} variant="outlined">
          Copy Direct URL
        </Button>
        <Button
          disabled={aacBusy || startingAac || !movie.link}
          onClick={handleStartAacTranscode}
          startIcon={(startingAac || aacBusy) ? <CircularProgress size={16} /> : <VideoLibraryIcon />}
          sx={{ width: { sm: 'auto', xs: '100%' } }}
          variant="outlined"
        >
          {aacBusy ? `AAC ${aacProgress}%` : 'Transcode AAC'}
        </Button>
      </Stack>
      {aacJob && aacJob.status !== 'idle' ? (
        <Box>
          <Stack direction={{ sm: 'row', xs: 'column' }} spacing={{ sm: 1, xs: 0 }} sx={{ alignItems: { sm: 'center', xs: 'flex-start' }, mb: 0.75 }}>
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

function DetailsPanel({ coverVersions, movie, onDeleteRequest, onPreview, onReload }) {
  if (!movie) {
    return (
      <SectionCard title="Episode Details" sx={{ minHeight: { lg: 642, xs: 320 } }}>
        <Box sx={{ display: 'grid', minHeight: { lg: 560, xs: 300 }, placeItems: 'center', px: { sm: 4, xs: 2 }, textAlign: 'center' }}>
          <Stack spacing={1.5} sx={{ alignItems: 'center' }}>
            <Avatar sx={{ bgcolor: 'action.selected', color: 'text.secondary', height: { sm: 76, xs: 62 }, width: { sm: 76, xs: 62 } }}>
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
    <Stack spacing={1.5}>
      <Box
        sx={{
          alignItems: 'center',
          aspectRatio: '16 / 9',
          bgcolor: '#050814',
          border: '1px solid',
          borderColor: 'rgba(148, 163, 184, 0.22)',
          borderRadius: 1,
          color: 'text.secondary',
          display: 'flex',
          justifyContent: 'center',
          overflow: 'hidden',
          position: 'relative'
        }}
      >
        {coverUrl ? (
          <Box
            alt={movie.displayName || movie.name}
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
          <Typography variant="body2">{movie.displayName || movie.name}</Typography>
        )}
        <Button
          onClick={onPreview}
          startIcon={<PlayArrowIcon />}
          sx={{
            bgcolor: 'primary.main',
            left: '50%',
            position: 'absolute',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            '&:hover': { bgcolor: 'primary.dark' }
          }}
          variant="contained"
        >
          Preview
        </Button>
      </Box>

      <CoverUploader movie={movie} onUploaded={onReload} />

      <Card variant="outlined" sx={{ bgcolor: 'rgba(16, 20, 43, 0.86)', borderColor: 'rgba(148, 163, 184, 0.2)' }}>
        <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
          <MetadataEditor movie={movie} onSaved={onReload} />
        </CardContent>
      </Card>

      <Card variant="outlined" sx={{ bgcolor: 'rgba(16, 20, 43, 0.86)', borderColor: 'rgba(148, 163, 184, 0.2)' }}>
        <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
          <DirectPlaybackPanel movie={movie} onCompatibleCreated={onReload} />
        </CardContent>
      </Card>

      <Stack direction={{ sm: 'row', xs: 'column' }} spacing={1} sx={{ alignItems: 'stretch' }}>
        <Button color="error" onClick={() => onDeleteRequest([movie.path], false)} startIcon={<DeleteOutlineIcon />} sx={{ flex: 1 }} variant="outlined">
          Delete Assets
        </Button>
        <Button color="error" onClick={() => onDeleteRequest([movie.path], true)} startIcon={<DeleteForeverIcon />} sx={{ flex: 1 }} variant="outlined">
          Delete File
        </Button>
      </Stack>

      <Paper
        variant="outlined"
        sx={{
          alignItems: 'center',
          bgcolor: 'rgba(8, 12, 28, 0.7)',
          borderColor: 'rgba(148, 163, 184, 0.16)',
          display: 'flex',
          gap: 1,
          minWidth: 0,
          p: 1.25
        }}
      >
        <LinkIcon color="primary" fontSize="small" />
        <Typography color="text.secondary" sx={{ minWidth: 0, overflowWrap: 'anywhere' }} variant="caption">
          {movie.link}
        </Typography>
      </Paper>
    </Stack>
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
        bottom: { sm: 24, xs: 12 },
        display: 'flex',
        flexDirection: { sm: 'row', xs: 'column' },
        gap: 1,
        left: '50%',
        maxWidth: { sm: 'calc(100% - 32px)', xs: 'calc(100% - 24px)' },
        p: 1.25,
        position: 'fixed',
        transform: 'translateX(-50%)',
        width: { sm: 'auto', xs: 'calc(100% - 24px)' },
        zIndex: theme => theme.zIndex.snackbar
      }}
    >
      <Typography sx={{ px: 1.25, textAlign: { sm: 'left', xs: 'center' }, whiteSpace: 'nowrap' }} variant="body2">
        <Box component="strong" sx={{ color: 'primary.light', fontSize: 18 }}>
          {selectedPaths.size}
        </Box>{' '}
        items selected
      </Typography>
      <Divider flexItem orientation="vertical" sx={{ display: { sm: 'block', xs: 'none' } }} />
      <Button color="error" onClick={() => onDeleteRequest(paths, false)} startIcon={<DeleteOutlineIcon />} sx={{ width: { sm: 'auto', xs: '100%' } }} variant="outlined">
        Delete Generated Assets
      </Button>
      <Button color="error" onClick={() => onDeleteRequest(paths, true)} startIcon={<DeleteForeverIcon />} sx={{ width: { sm: 'auto', xs: '100%' } }} variant="contained">
        Delete Movie Files
      </Button>
      <Button onClick={onClear} sx={{ width: { sm: 'auto', xs: '100%' } }} variant="text">
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
  const [mobileTab, setMobileTab] = useState('list');
  const [detailTab, setDetailTab] = useState('details');
  const [searchTerm, setSearchTerm] = useState('');
  const isMobileLayout = useMediaQuery(theme => theme.breakpoints.down('lg'));

  const selectedMovie = useMemo(
    () => movies.find(movie => movie.path === selectedPath) || null,
    [movies, selectedPath]
  );
  const filteredMovies = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return movies;
    return movies.filter(movie => {
      const haystack = [
        movie.displayName,
        movie.name,
        movie.folder,
        movie.path,
        movie.episodeNumber ? `tap ${movie.episodeNumber}` : ''
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }, [movies, searchTerm]);

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

  function handleSelectMovie(path) {
    setSelectedPath(path);
    if (isMobileLayout) setMobileTab('details');
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
  const fileManagerPanel = (
    <Stack spacing={1.5}>
      <SectionCard
        action={null}
        title="Local Movies"
        sx={{ minHeight: 132 }}
      >
        <CardContent sx={{ px: 2, pt: 2.5, pb: 1.5, '&:last-child': { pb: 1.5 } }}>
          <Typography color="text.secondary" noWrap variant="caption">
            D:/Movies
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 3 }}>
            <Chip label={`${movies.length} items`} size="small" sx={{ bgcolor: 'rgba(148, 163, 184, 0.14)', fontWeight: 800 }} />
            <Chip label={`${movies.filter(movie => movie.link).length} playable`} size="small" sx={{ bgcolor: 'rgba(148, 163, 184, 0.2)', fontWeight: 800 }} />
          </Stack>
        </CardContent>
      </SectionCard>

      <TextField
        fullWidth
        onChange={event => setSearchTerm(event.target.value)}
        placeholder="Search episodes..."
        size="small"
        value={searchTerm}
        InputProps={{
          startAdornment: <SearchIcon sx={{ color: 'text.secondary', fontSize: 20, mr: 1 }} />
        }}
        sx={{
          '& .MuiOutlinedInput-root': {
            bgcolor: 'rgba(16, 20, 43, 0.86)',
            borderRadius: 1
          }
        }}
      />

      <MovieList
        loading={loading}
        movies={filteredMovies}
        onSelect={handleSelectMovie}
        onToggleSelect={toggleSelected}
        selectedPath={selectedPath}
        selectedPaths={selectedPaths}
      />
    </Stack>
  );
  const detailsPanel = (
    <Stack spacing={1.5}>
      <Tabs
        onChange={(_, value) => setDetailTab(value)}
        value={detailTab}
        sx={{
          alignSelf: 'flex-start',
          border: '1px solid rgba(148, 163, 184, 0.22)',
          borderRadius: 1,
          minHeight: 36,
          '& .MuiTab-root': { minHeight: 36, px: 1.5 },
          '& .MuiTabs-indicator': { display: 'none' }
        }}
      >
        <Tab label="Details" value="details" />
        <Tab label="Files" value="files" />
        <Tab label="Player" value="player" />
      </Tabs>

      {detailTab === 'details' ? (
        <DetailsPanel
          coverVersions={coverVersions}
          movie={selectedMovie}
          onDeleteRequest={requestDelete}
          onPreview={() => setDetailTab('player')}
          onReload={reloadMoviesAndBustCover}
        />
      ) : null}
      {detailTab === 'files' ? (
        <SectionCard title="File Info">
          <CardContent>
            <Typography color="text.secondary" sx={{ overflowWrap: 'anywhere' }} variant="body2">
              {selectedMovie?.path || 'Select a movie to inspect its source file.'}
            </Typography>
          </CardContent>
        </SectionCard>
      ) : null}
      {detailTab === 'player' ? <Player active={Boolean(readyForPlayer)} movie={selectedMovie} /> : null}
    </Stack>
  );

  return (
    <Box sx={{ minHeight: '100vh', pb: 12 }}>
      <AppBar color="transparent" elevation={0} position="sticky" sx={{ bgcolor: 'rgba(10, 14, 35, 0.88)', backdropFilter: 'blur(18px)', borderBottom: '1px solid rgba(148, 163, 184, 0.14)' }}>
        <Toolbar sx={{ gap: 1.25, minHeight: 76, mx: 'auto', width: 'min(1180px, 100%)' }}>
          <Avatar
            variant="rounded"
            sx={{
              background: 'linear-gradient(135deg, #8b5cf6 0%, #22d3ee 100%)',
              color: 'primary.contrastText',
              fontSize: 18,
              height: 42,
              width: 42
            }}
          >
            <PlayArrowIcon />
          </Avatar>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography noWrap variant="h6">
              StreamTV
            </Typography>
            <Typography color="text.secondary" noWrap variant="caption">
              Content Management System
            </Typography>
          </Box>
          <Tooltip title="Settings">
            <IconButton aria-label="Settings" size="small">
              <SettingsOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>

      <Box component="main" sx={{ mx: 'auto', p: { md: 3, xs: 1.5 }, width: 'min(1180px, 100%)' }}>
        <Stack spacing={2}>
          <Paper
            variant="outlined"
            sx={{
              display: { lg: 'none', xs: 'block' },
              overflow: 'hidden'
            }}
          >
            <Tabs
              onChange={(_, value) => setMobileTab(value)}
              value={mobileTab}
              variant="fullWidth"
            >
              <Tab label="Danh sách" value="list" />
              <Tab label="Chi tiết" value="details" />
            </Tabs>
          </Paper>

          <Box sx={{ display: { lg: 'none', xs: 'block' } }}>
            {mobileTab === 'list' ? fileManagerPanel : detailsPanel}
          </Box>

          <Box
            sx={{
              alignItems: 'flex-start',
              display: { lg: 'grid', xs: 'none' },
              gap: 2,
              gridTemplateColumns: '360px minmax(0, 1fr)'
            }}
          >
            {fileManagerPanel}
            {detailsPanel}
          </Box>
        </Stack>
      </Box>

      <BulkBar onClear={() => setSelectedPaths(new Set())} onDeleteRequest={requestDelete} selectedPaths={selectedPaths} />

      <Dialog
        fullWidth
        maxWidth="xs"
        onClose={() => (!deleteBusy ? setPendingDelete(null) : null)}
        open={Boolean(pendingDelete)}
        PaperProps={{ sx: { m: { sm: 3, xs: 1.5 } } }}
      >
        <DialogTitle>Confirm delete</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Delete {deleteLabel} for {pendingDelete?.paths.length || 0} item(s)? This action cannot be undone from the CMS.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ flexDirection: { sm: 'row', xs: 'column-reverse' }, gap: { sm: 0, xs: 1 }, px: { sm: 3, xs: 2 } }}>
          <Button disabled={deleteBusy} onClick={() => setPendingDelete(null)}>
            Cancel
          </Button>
          <Button
            color="error"
            disabled={deleteBusy}
            onClick={confirmDelete}
            startIcon={deleteBusy ? <CircularProgress size={16} /> : <DeleteForeverIcon />}
            sx={{ width: { sm: 'auto', xs: '100%' } }}
            variant="contained"
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        anchorOrigin={{ horizontal: isMobileLayout ? 'center' : 'right', vertical: isMobileLayout ? 'bottom' : 'top' }}
        autoHideDuration={5000}
        onClose={() => setNotice('')}
        open={Boolean(notice)}
        sx={{ bottom: { xs: selectedPaths.size > 0 ? 178 : 16, sm: 24 }, left: { xs: 12, sm: 'auto' }, right: { xs: 12, sm: 24 } }}
      >
        <Alert onClose={() => setNotice('')} severity={notice.toLowerCase().includes('failed') ? 'error' : 'info'} sx={{ width: { xs: '100%', sm: 'auto' } }} variant="filled">
          {notice}
        </Alert>
      </Snackbar>
    </Box>
  );
}
