import React from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import App from './App.jsx';
import './styles.css';

const theme = createTheme({
  palette: {
    mode: 'dark',
    background: {
      default: '#0b1018',
      paper: '#111927'
    },
    primary: {
      main: '#7c4dff',
      light: '#b69cff'
    },
    secondary: {
      main: '#26c6da'
    },
    success: {
      main: '#2e7d32'
    },
    error: {
      main: '#d32f2f'
    }
  },
  shape: {
    borderRadius: 8
  },
  typography: {
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    h5: {
      fontSize: '1.2rem',
      fontWeight: 800
    },
    h6: {
      fontWeight: 800
    },
    button: {
      fontWeight: 800,
      textTransform: 'none'
    }
  },
  components: {
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none'
        }
      }
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none'
        }
      }
    },
    MuiButton: {
      defaultProps: {
        disableElevation: true
      }
    }
  }
});

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
