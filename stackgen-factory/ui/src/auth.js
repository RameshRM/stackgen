/**
 * Signing in.
 *
 * One request. The provider has no passwords, so the authorization-code dance
 * was protecting nothing while adding three single-use values for a browser to
 * drop — and it dropped them.
 *
 * What is kept is the part that matters: the token is signed by the provider
 * and verified by the control plane, so team and roles are asserted by
 * somebody other than the person asking. Swapping in a real provider changes
 * this file and nothing behind it.
 *
 * The token lives in sessionStorage: gone when the tab closes, and not shared
 * with another tab or another origin. In memory would be safer still, and
 * would mean signing in again on every reload.
 */

const KEY = 'factory.token';

export function currentToken() {
    try {
        return sessionStorage.getItem(KEY);
    } catch (error) {
        return null;
    }
}

export function signedIn() {
    return Boolean(currentToken());
}

/** Where the provider is. The control plane says, so the UI holds no URL. */
export async function identity() {
    const response = await fetch('/api/identity');
    if (!response.ok) {
        throw new Error('the control plane did not say where to sign in');
    }
    return response.json();
}

/** Who may sign in. From the provider, so the UI keeps no copy to disagree. */
export async function accounts() {
    const where = await identity();
    const response = await fetch(where.issuer + '/accounts');
    if (!response.ok) {
        throw new Error('the provider would not say who exists');
    }
    return (await response.json()).accounts;
}

export async function signIn(account) {
    const where = await identity();
    const response = await fetch(where.token, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'mock_password', account }),
    });

    const body = await response.json();
    if (!response.ok || !body.access_token) {
        throw new Error(body.error || 'the provider refused');
    }

    sessionStorage.setItem(KEY, body.access_token);
    return body.access_token;
}

export function signOut() {
    sessionStorage.removeItem(KEY);
}
