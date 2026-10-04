import { useEffect, useState } from 'react';
import { accounts, signIn } from '../auth';
import { card, colour, mono } from '../theme';

/**
 * Choose who to be.
 *
 * The list comes from the provider, so this screen cannot offer somebody the
 * control plane would reject. There is no password because the directory is a
 * mock — what is not mocked is the token, which is signed and verified.
 */
export default function SignIn({ onSignedIn }) {
    const [people, setPeople] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(null);

    useEffect(() => {
        accounts().then(setPeople).catch((e) => setError(e.message));
    }, []);

    async function become(id) {
        setBusy(id);
        setError(null);
        try {
            await signIn(id);
            onSignedIn();
        } catch (e) {
            setError(e.message);
            setBusy(null);
        }
    }

    return (
        <div style={{
            minHeight: '100vh', display: 'flex', alignItems: 'center',
            justifyContent: 'center', background: colour.ground,
        }}>
            <div style={{ ...card, width: 380, display: 'flex',
                flexDirection: 'column', gap: 16 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ fontSize: 19, fontWeight: 600 }}>
                        Sign in to the factory
                    </div>
                    <div style={{ fontSize: 13, color: colour.muted }}>
                        Choose who to be. No password: this is a mock directory.
                    </div>
                </div>

                {error && (
                    <div style={{ fontSize: 13, color: colour.denyInk }}>{error}</div>
                )}

                {!people ? (
                    <div style={{ fontSize: 13, color: colour.muted }}>Loading…</div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {people.map((person) => (
                            <button key={person.id} type="button"
                                disabled={Boolean(busy)}
                                onClick={() => become(person.id)}
                                style={{
                                    display: 'flex', justifyContent: 'space-between',
                                    alignItems: 'baseline', gap: 12, textAlign: 'left',
                                    padding: '11px 13px', minHeight: 44,
                                    border: `1px solid ${colour.line}`, borderRadius: 7,
                                    background: busy === person.id ? colour.fill : colour.surface,
                                    cursor: busy ? 'default' : 'pointer',
                                    fontSize: 14, color: colour.ink,
                                }}>
                                <strong style={{ fontWeight: 500 }}>{person.id}</strong>
                                <span style={{ ...mono, fontSize: 11, color: colour.muted }}>
                                    {person.team}
                                    {person.roles.length ? ' · ' + person.roles.join(', ') : ''}
                                </span>
                            </button>
                        ))}
                    </div>
                )}

                <div style={{ fontSize: 11, color: colour.faint, lineHeight: 1.5 }}>
                    The token is signed. Team and roles come from it, not from you.
                </div>
            </div>
        </div>
    );
}
