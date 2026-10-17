import { rethrowUnexpectedError } from './expected-errors.js';

// How often the maintenance page asks whether MetaList is back.
const MAINTENANCE_POLL_INTERVAL_MS = 200;

function checkMaintenanceStatus() {
    fetch('/', {method: 'GET', cache: 'no-cache'}).then(response => {
        if (response.ok && !response.redirected) {
            window.location.href = '/';
        } else {
            setTimeout(checkMaintenanceStatus, MAINTENANCE_POLL_INTERVAL_MS);
        }
    }).catch(error => {
        rethrowUnexpectedError(error);
        setTimeout(checkMaintenanceStatus, MAINTENANCE_POLL_INTERVAL_MS);
    });
}

setTimeout(checkMaintenanceStatus, MAINTENANCE_POLL_INTERVAL_MS);
