import { rethrowUnexpectedError } from '../expected-errors.js';
import { AuthenticationRequiredError } from '../client-state-api.js';

const EXPIRED_SESSION_MESSAGE = 'Your session has expired. Please log in again.';


export async function persistUsageBeforeActivation({
    persistUsage,
    handleAuthenticationRequired,
}) {
    if (typeof persistUsage !== 'function') {
        throw new Error('persistUsageBeforeActivation requires persistUsage function');
    }
    if (typeof handleAuthenticationRequired !== 'function') {
        throw new Error('persistUsageBeforeActivation requires handleAuthenticationRequired function');
    }

    return await persistUsage().then(
        () => true,
        (error) => {
            rethrowUnexpectedError(error);
            if (!(error instanceof AuthenticationRequiredError)) {
                throw error;
            }
            handleAuthenticationRequired(EXPIRED_SESSION_MESSAGE);
            return false;
        },
    );
}
