import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
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
  LinearProgress,
  List,
  ListItem,
  ListItemAvatar,
  ListItemButton,
  ListItemText,
  Paper,
  Skeleton,
  Snackbar,
  Stack,
  TextField,
  Toolbar,
  Tooltip,
  Typography
} from '@mui/material';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlined';
import FolderIcon from '@mui/icons-material/Folder';
import LinkIcon from '@mui/icons-material/Link';
import MovieFilterIcon from '@mui/icons-material/MovieFilter';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
import SaveIcon from '@mui/icons-material/Save';
import ScheduleIcon from '@mui/icons-material/Schedule';
import VideoLibraryIcon from '@mui/icons-material/VideoLibrary';
import {
  deleteMovies,
  fetchMovies,
  fetchProgress,
  fetchTranscodeStatus,
  getCoverUrl,
  getM3u8Url,
  saveMetadata,
  saveProgress,
  startAutoTranscode,
  startTranscode,
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

function getStatusLabel(movie, liveStatus) {
  if (liveStatus?.status === 'processing') return `${Math.round(Number(liveStatus.progress) || 0)}%`;
  if (liveStatus?.status === 'error') return 'ERROR';
  if (liveStatus?.status === 'completed') return 'READY';
  return movie.isTranscoded ? 'READY' : 'RAW';
}

function getStatusColor(movie, liveStatus) {
  if (liveStatus?.status === 'error') return 'error';
  if (liveStatus?.status === 'processing') return 'info';
  if (liveStatus?.status === 'completed' || movie.isTranscoded) return 'success';
  return 'default';
}

function getStatusIcon(movie, liveStatus) {
  if (liveStatus?.status === 'error') return <ErrorOutlineIcon />;
  if (liveStatus?.status === 'processing') return <ScheduleIcon />;
  if (liveStatus?.status === 'completed' || movie.isTranscoded) return <CheckCircleIcon />;
  return <MovieFilterIcon />;
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

function MovieThumb({ coverPath, version }) {
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
      {coverPath ? (
        <Box
          alt=""
          component="img"
          src={`${getCoverUrl(coverPath)}?v=${version || 0}`}
          sx={{ height: '100%', objectFit: 'cover', width: '100%' }}
        />
      ) : (
        'STV'
      )}
    </Avatar>
  );
}

function MovieList({ coverVersions, movies, selectedPath, selectedPaths, statuses, loading, onSelect, onToggleSelect }) {
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
        const liveStatus = statuses[movie.path];
        const selected = selectedPath === movie.path;
        const checked = selectedPaths.has(movie.path);
        const coverPath = movie.hasCover ? movie.coverBasePath || movie.path : null;

        return (
          <ListItem
            disablePadding
            key={movie.path}
            secondaryAction={
              <Chip
                color={getStatusColor(movie, liveStatus)}
                icon={getStatusIcon(movie, liveStatus)}
                label={getStatusLabel(movie, liveStatus)}
                size="small"
                sx={{ minWidth: 78 }}
                variant={getStatusColor(movie, liveStatus) === 'default' ? 'outlined' : 'filled'}
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
                  <MovieThumb coverPath={coverPath} version={coverVersions[coverPath]} />
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
      await onUploaded(movie.path, result.coverBasePath || movie.path);
    } catch (error) {
      setStatus(error.message || 'Upload failed.');
      setStatusType('error');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
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
          disabled={uploading}
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

function TranscodePanel({ movie, status, onStatus, onMovieReady }) {
  const [busy, setBusy] = useState(false);
  const [copyState, setCopyState] = useState('');

  const sourceResolution = useMemo(() => getSourceResolution(movie), [movie]);
  const progress = Number(status?.progress) || 0;
  const isProcessing = status?.status === 'processing';
  const isCompleted = status?.status === 'completed' || movie?.isTranscoded;
  const hasError = status?.status === 'error';

  useEffect(() => {
    setCopyState('');
  }, [movie?.path]);

  if (!movie) return null;

  async function handleStart() {
    setBusy(true);
    try {
      await startTranscode(movie.path);
      const nextStatus = await fetchTranscodeStatus(movie.path);
      onStatus(movie.path, nextStatus);
    } catch (error) {
      onStatus(movie.path, { status: 'error', progress: 0, error: error.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    const url = getM3u8Url(movie.path);
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

  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography color="text.secondary" sx={{ mb: 0.75 }} variant="caption">
          Output quality
        </Typography>
        {sourceResolution ? (
          <Typography color="text.secondary" sx={{ display: 'block', mb: 0.5 }} variant="caption">
            Source: {sourceResolution.width}x{sourceResolution.height}
          </Typography>
        ) : null}
        <Chip label="Original source" size="small" variant="outlined" />
      </Box>
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
        <Button
          disabled={busy || isProcessing || isCompleted}
          onClick={handleStart}
          startIcon={busy || isProcessing ? <CircularProgress size={16} /> : <PlayArrowIcon />}
          variant="contained"
        >
          {isProcessing ? 'Transcoding' : isCompleted ? 'Ready' : 'Start Transcoding'}
        </Button>
        {isCompleted ? (
          <Button onClick={handleCopy} startIcon={<ContentCopyIcon />} variant="outlined">
            Copy M3U8
          </Button>
        ) : null}
        {isCompleted ? (
          <Button onClick={() => onMovieReady(movie.path)} startIcon={<RefreshIcon />} variant="outlined">
            Refresh Player
          </Button>
        ) : null}
      </Stack>
      {isProcessing ? (
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
          <LinearProgress sx={{ flex: 1 }} value={Math.min(100, Math.max(0, progress))} variant="determinate" />
          <Typography color="primary.light" sx={{ minWidth: 42, textAlign: 'right' }} variant="caption">
            {Math.round(progress)}%
          </Typography>
        </Stack>
      ) : null}
      {hasError ? (
        <Alert severity="error" variant="outlined">
          {status.error || 'Transcode failed.'}
        </Alert>
      ) : null}
      {copyState ? (
        <Alert severity={copyState === 'Copied.' ? 'success' : 'error'} variant="outlined">
          {copyState}
        </Alert>
      ) : null}
    </Stack>
  );
}

function Player({ movie, active }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const lastSavedRef = useRef(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!movie || !active || !video) return undefined;

    const source = getM3u8Url(movie.path);
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

    if (Hls.isSupported()) {
      const hls = new Hls({ renderTextTracksNatively: false });
      hlsRef.current = hls;
      hls.loadSource(source);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, restoreProgress);
      hls.on(Hls.Events.ERROR, (event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else hls.destroy();
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = source;
      video.addEventListener('loadedmetadata', restoreProgress, { once: true });
    }

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
      video.removeAttribute('src');
      video.load();
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [movie, active]);

  if (!movie || !active) return null;

  return (
    <Card variant="outlined" sx={{ overflow: 'hidden', position: 'relative' }}>
      <Box component="video" controls crossOrigin="anonymous" preload="none" ref={videoRef} sx={{ bgcolor: '#000', display: 'block', width: '100%' }} />
      <Chip
        icon={<VideoLibraryIcon />}
        label="HLS Player"
        size="small"
        sx={{ left: 12, position: 'absolute', top: 12 }}
        variant="filled"
      />
    </Card>
  );
}

function DetailsPanel({ coverVersions, movie, status, onDeleteRequest, onReload, onStatus }) {
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
              View details, edit metadata, upload a cover, transcode, or manage generated HLS output.
            </Typography>
          </Stack>
        </Box>
      </SectionCard>
    );
  }

  const coverPath = movie.hasCover ? movie.coverBasePath || movie.path : null;
  const ready = status?.status === 'completed' || movie.isTranscoded;

  return (
    <SectionCard
      action={
        <Chip
          color={getStatusColor(movie, status)}
          icon={getStatusIcon(movie, status)}
          label={getStatusLabel(movie, status)}
          size="small"
          variant={getStatusColor(movie, status) === 'default' ? 'outlined' : 'filled'}
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
            {coverPath ? (
              <Box
                alt=""
                component="img"
                src={`${getCoverUrl(coverPath)}?v=${coverVersions[coverPath] || 0}`}
                sx={{ height: '100%', objectFit: 'cover', width: '100%' }}
              />
            ) : (
              <Typography variant="body2">No cover</Typography>
            )}
          </Box>

          <CoverUploader movie={movie} onUploaded={onReload} />
          <Divider />
          <MetadataEditor movie={movie} onSaved={onReload} />
          <Divider />
          <TranscodePanel movie={movie} onMovieReady={onReload} onStatus={onStatus} status={status} />
          <Divider />
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
            <Button color="error" onClick={() => onDeleteRequest([movie.path], false)} startIcon={<DeleteOutlineIcon />} variant="outlined">
              Delete HLS Only
            </Button>
            <Button color="error" onClick={() => onDeleteRequest([movie.path], true)} startIcon={<DeleteForeverIcon />} variant="contained">
              Delete Everything
            </Button>
          </Stack>

          {ready ? (
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
                {getM3u8Url(movie.path)}
              </Typography>
            </Paper>
          ) : null}
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
        Delete HLS Only
      </Button>
      <Button color="error" onClick={() => onDeleteRequest(paths, true)} startIcon={<DeleteForeverIcon />} variant="contained">
        Delete Everything
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
  const [statuses, setStatuses] = useState({});
  const [coverVersions, setCoverVersions] = useState({});
  const [notice, setNotice] = useState('');
  const [autoBusy, setAutoBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const selectedMovie = useMemo(
    () => movies.find(movie => movie.path === selectedPath) || null,
    [movies, selectedPath]
  );

  const loadMovies = useCallback(async preferredPath => {
    setLoading(true);
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
      setLoading(false);
    }
  }, []);

  const reloadMoviesAndBustCover = useCallback(
    async (preferredPath, coverPath) => {
      await loadMovies(preferredPath);
      setCoverVersions(current => ({
        ...current,
        [preferredPath]: Date.now(),
        ...(coverPath ? { [coverPath]: Date.now() } : {})
      }));
    },
    [loadMovies]
  );

  useEffect(() => {
    loadMovies();
  }, [loadMovies]);

  useEffect(() => {
    const source = new EventSource('/events');
    source.addEventListener('progress', event => {
      const data = JSON.parse(event.data);
      setStatuses(current => ({
        ...current,
        [data.filename]: { ...(current[data.filename] || {}), status: 'processing', progress: data.progress }
      }));
    });
    source.addEventListener('finished', event => {
      const data = JSON.parse(event.data);
      setStatuses(current => ({
        ...current,
        [data.filename]: {
          ...(current[data.filename] || {}),
          status: data.status,
          progress: data.status === 'completed' ? 100 : 0,
          error: data.error
        }
      }));
      if (data.status === 'completed') loadMovies(data.filename);
    });
    source.onerror = () => {
      setNotice('Realtime connection interrupted. Status polling still works when selecting a movie.');
    };
    return () => source.close();
  }, [loadMovies]);

  useEffect(() => {
    if (!selectedPath) return undefined;
    let cancelled = false;
    let timer = null;

    async function poll() {
      try {
        const status = await fetchTranscodeStatus(selectedPath);
        if (cancelled) return;
        setStatuses(current => ({ ...current, [selectedPath]: status }));
        if (status.status === 'processing') {
          timer = window.setTimeout(poll, 3000);
        }
      } catch (error) {
        if (!cancelled) setNotice(error.message || 'Failed to read transcode status.');
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [selectedPath]);

  function setMovieStatus(path, status) {
    setStatuses(current => ({ ...current, [path]: status }));
  }

  function toggleSelected(path) {
    setSelectedPaths(current => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function handleAutoTranscode() {
    setAutoBusy(true);
    try {
      await startAutoTranscode();
      setNotice('Auto-transcode scan started.');
      await loadMovies(selectedPath);
    } catch (error) {
      setNotice(error.message || 'Failed to start auto-transcode.');
    } finally {
      setAutoBusy(false);
    }
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

  const readyForPlayer = selectedMovie && (selectedMovie.isTranscoded || statuses[selectedMovie.path]?.status === 'completed');
  const deleteLabel = pendingDelete?.deleteOriginal ? 'original files and HLS output' : 'HLS output';

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
              HLS transcoding and streaming dashboard
            </Typography>
          </Box>
          <Tooltip title="Scan library and transcode raw files">
            <span>
              <Button
                disabled={autoBusy}
                onClick={handleAutoTranscode}
                startIcon={autoBusy ? <CircularProgress size={16} /> : <AutoFixHighIcon />}
                variant="contained"
              >
                {autoBusy ? 'Scanning' : 'Auto Transcode All'}
              </Button>
            </span>
          </Tooltip>
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
                label={`${movies.filter(movie => movie.isTranscoded).length} ready`}
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
                statuses={statuses}
              />
            </SectionCard>

            <Stack spacing={2}>
              <DetailsPanel
                coverVersions={coverVersions}
                movie={selectedMovie}
                onDeleteRequest={requestDelete}
                onReload={reloadMoviesAndBustCover}
                onStatus={setMovieStatus}
                status={selectedMovie ? statuses[selectedMovie.path] : null}
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
