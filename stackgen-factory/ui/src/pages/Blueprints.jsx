import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { card, colour, label, mono, pill } from '../theme';

const COLUMNS = '1fr 76px 132px 128px 152px 150px';

function Row({ children, header, last }) {
    return (
        <div style={{
            display: 'grid', gridTemplateColumns: COLUMNS, gap: 14,
            padding: header ? '11px 18px' : '15px 18px',
            alignItems: 'center',
            background: header ? colour.fill : 'transparent',
            borderBottom: (header || !last) ? `1px solid ${header ? colour.line : colour.lineFaint}` : 'none',
            ...(header ? label : {}),
        }}>
            {children}
        </div>
    );
}

export default function Blueprints() {
    const [state, setState] = useState({ loading: true });

    useEffect(() => {
        api.blueprints()
            .then((data) => setState({ blueprints: data.blueprints }))
            .catch((error) => setState({ error: error.message }));
    }, []);

    if (state.loading) return <div style={{ color: colour.muted }}>Loading…</div>;
    if (state.error) return <div style={{ color: colour.denyInk }}>{state.error}</div>;

    const mayAuthor = state.blueprints.some((b) => b.may_author);

    return (
        <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: '-0.01em' }}>
                        Blueprints
                    </h1>
                    <div style={{ fontSize: 13, color: colour.muted }}>
                        A blueprint governs an operation: what may happen, in what order,
                        who approves, and what counts as success.
                    </div>
                </div>
                {mayAuthor && (
                    <Link to="/blueprints/new" style={{
                        boxSizing: 'border-box', padding: '10px 18px', minHeight: 44,
                        borderRadius: 7, background: colour.ink, color: colour.onRail,
                        fontSize: 14, fontWeight: 500, textDecoration: 'none',
                        display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
                    }}>New blueprint</Link>
                )}
            </div>

            <div style={{ ...card, padding: '14px 16px', flexDirection: 'row', gap: 12 }}>
                <div style={{ fontSize: 12, color: colour.body, lineHeight: 1.6 }}>
                    {mayAuthor
                        ? 'You hold platform-admin, so you may author. A developer sees this list without New blueprint or Edit — they read what is shared and submit against it.'
                        : 'Authoring requires platform-admin. You may read every shared blueprint and submit against it.'}
                </div>
            </div>

            <div style={{ background: colour.surface, border: `1px solid ${colour.line}`, borderRadius: 9, overflow: 'hidden' }}>
                <Row header>
                    <div>BLUEPRINT</div><div>VERSION</div><div>OWNER</div>
                    <div>VISIBILITY</div><div>GATES</div><div>STATE</div>
                </Row>

                {state.blueprints.map((bp, i) => (
                    <Row key={bp.name} last={i === state.blueprints.length - 1}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <Link to={`/blueprints/${bp.name}`} style={{
                                fontSize: 14, fontWeight: 500, color: colour.ink,
                                textDecoration: 'underline', textUnderlineOffset: 2,
                            }}>{bp.name}</Link>
                            <div style={{ fontSize: 11, color: colour.muted }}>
                                {bp.actions.join(', ')} · {bp.environments.join(' → ')}
                            </div>
                        </div>

                        <div style={{ ...mono, fontSize: 13 }}>v{bp.version}</div>
                        <div style={{ ...mono, fontSize: 12, color: colour.body }}>{bp.owner_team}</div>
                        <div>
                            <span style={pill(bp.visibility === 'shared' ? 'pass' : 'neutral')}>
                                {bp.visibility === 'shared' ? 'shared' : 'team only'}
                            </span>
                        </div>

                        <div style={{ fontSize: 12, color: colour.body }}>
                            {bp.gates.length
                                ? bp.gates.map((g) => g.approver_role || 'anyone').join(', ')
                                : <span style={{ color: colour.faint }}>none</span>}
                        </div>

                        <div>
                            {bp.publishable
                                ? <span style={pill('pass')}>published</span>
                                : <span style={pill('deny')}>{bp.problems} problem{bp.problems === 1 ? '' : 's'}</span>}
                            {bp.warnings > 0 && (
                                <span style={{ ...pill('wait'), marginLeft: 6 }}>
                                    {bp.warnings} warning{bp.warnings === 1 ? '' : 's'}
                                </span>
                            )}
                        </div>
                    </Row>
                ))}
            </div>

            {state.blueprints.length === 0 && (
                <div style={{ ...card, color: colour.muted, fontSize: 13 }}>
                    No blueprints are visible to you. A team-scoped blueprint owned by
                    another team is not listed.
                </div>
            )}
        </>
    );
}
