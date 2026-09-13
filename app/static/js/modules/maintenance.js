import { rethrowUnexpectedError } from './expected-errors.js';

function checkMaintenanceStatus() {
    fetch('/', {method: 'GET', cache: 'no-cache'}).then(response => {
        if (response.ok && !response.redirected) {
            window.location.href = '/';
        } else {
            setTimeout(checkMaintenanceStatus, 200);
        }
    }).catch(error => {
        rethrowUnexpectedError(error);
        setTimeout(checkMaintenanceStatus, 200);
    });
}

setTimeout(checkMaintenanceStatus, 200);
