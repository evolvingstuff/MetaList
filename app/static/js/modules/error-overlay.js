import { ApplicationState } from './application-state.js';
import { isNetworkTransportError } from './api-failure-classification-service.js';


const moduleState = ApplicationState.createFields('error-overlay', {
    installed: false,
});


export function shouldSuppressFatalOverlay(reason) {
  return isNetworkTransportError(reason);
}

function ensureOverlay() {
  let overlay = document.getElementById('fatal-error-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'fatal-error-overlay';
    Object.assign(overlay.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      background: '#8b0000',
      color: '#fff',
      padding: '10px 14px',
      fontFamily: 'monospace',
      fontSize: '13px',
      zIndex: '10000',
      whiteSpace: 'pre-wrap',
      borderBottom: '2px solid #550000',
      maxHeight: '40vh',
      overflowY: 'auto',
    });
    document.body.appendChild(overlay);
  }
  return overlay;
}

export function showFatalError(message, details) {
  const overlay = ensureOverlay();
  const time = new Date().toISOString();
  const lines = [
    `[${time}] FATAL: ${String(message)}`,
    details ? String(details) : '',
  ].filter(Boolean);
  overlay.textContent = lines.join('\n');
}

export function installGlobalErrorOverlay() {
  if (moduleState.installed) return;
  moduleState.installed = true;

  window.addEventListener('error', (event) => {
    let msg = null;
    if (event && event.error && typeof event.error.message === 'string') {
      msg = event.error.message;
    } else if (event && typeof event.message === 'string') {
      msg = event.message;
    } else {
      msg = 'Uncaught error';
    }

    let stack = '';
    if (event && event.error && typeof event.error.stack === 'string') {
      stack = event.error.stack;
    }
    showFatalError(msg, stack);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason;
    if (shouldSuppressFatalOverlay(reason)) {
      event.preventDefault();
      console.info('[ErrorOverlay] Connection failure is already shown in the status banner');
      return;
    }
    let msg = null;
    if (reason && typeof reason.message === 'string') {
      msg = reason.message;
    } else if (reason) {
      msg = String(reason);
    } else {
      msg = 'Unhandled promise rejection';
    }
    const stack = reason && reason.stack ? reason.stack : '';
    showFatalError(msg, stack);
  });
}
