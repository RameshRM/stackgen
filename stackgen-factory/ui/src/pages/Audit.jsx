import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { card, colour, mono, pill } from '../theme';

/**
 * Every decision recorded, newest first.
 *
 * Including the ones nobody clicked. A workflow submitted as a side effect of
 * creating a document still has a principal and a reason, because an action with
 * no record is an action nobody can be asked about.
 */

function decisionPill(decision) {
    const map = {
        allow: 'pass', pass: 'pass',
        deny: 'deny', error: 'deny', fail: 'deny',
        cannot_tell: 'unknown',
    };
    return pill(map[decision] || 'neutral');
}

export default function Audit() {
    const [state, setState] = useState({ loading: true });

    useEffect(() => {
        api.audit()
            .then((body) => setState({ audit: body.audit }))
            .catch((e) => setState({ error: e.message }));
    }, []);

    if (state.loading) {
        return <div style={{ color: colour.muted }}>Loading…</div>;
    }
    if (state.error) {
        return <div style={{ color: colour.denyInk }}>{state.error}</div>;
    }

    return (
        <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: '-0.01em' }}>
                    Audit
                </h1>
                <div style={{ fontSize: 13, color: colour.muted }}>
                    Who asked, what was decided, and why. Refusals are kept as carefully
                    as permissions.
                </div>
            </div>

            {state.audit.length === 0 ? (
                <div style={{ ...card, color: colour.muted, fontSize: 13 }}>
                    Nothing has been recorded for your team yet.
                </div>
            ) : (
                <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
                    {state.audit.map((entry, index) => (
                        <div key={entry.id} style={{
                            display: 'flex', gap: 13, alignItems: 'flex-start',
                            padding: '12px 18px',
                            borderTop: index === 0 ? 'none' : `1px solid ${colour.lineFaint}`,
                        }}>
                            <span style={{ ...mono, fontSize: 11, color: colour.faint,
                                whiteSpace: 'nowrap', paddingTop: 3, width: 118 }}>
                                {entry.at.slice(0, 19).replace('T', ' ')}
                            </span>
                            <span style={{ ...decisionPill(entry.decision), flexShrink: 0 }}>
                                {entry.decision}
                            </span>
                            <span style={{ display: 'flex', flexDirection: 'column', gap: 3,
                                minWidth: 0, flexGrow: 1 }}>
                                <span style={{ display: 'flex', gap: 9, alignItems: 'baseline',
                                    flexWrap: 'wrap' }}>
                                    <span style={{ ...mono, fontSize: 12, color: colour.ink }}>
                                        {entry.action}
                                    </span>
                                    <Link to={`/deployments/${entry.spec_id}`} style={{
                                        ...mono, fontSize: 11, color: colour.muted,
                                    }}>{entry.spec_id}</Link>
                                </span>
                                <span style={{ fontSize: 12, color: colour.body, lineHeight: 1.5 }}>
                                    {entry.reason}
                                </span>
                                <span style={{ fontSize: 11, color: colour.faint }}>
                                    {entry.principal_id} ({entry.principal_type})
                                    {entry.detail && entry.detail.applied
                                        ? ` · ${entry.detail.applied.length} applied`
                                        : ''}
                                </span>
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </>
    );
}
