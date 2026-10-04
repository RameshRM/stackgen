import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { card, colour, label, mono, pill } from '../theme';

/**
 * The deployment specs this team owns.
 *
 * Scoped by the API, not here: another team's specs never reach the browser.
 */

const COLUMNS = '1fr 130px 120px 190px 150px';

function Row({ children, header, last }) {
    return (
        <div style={{
            display: 'grid', gridTemplateColumns: COLUMNS, gap: 14,
            padding: header ? '11px 18px' : '15px 18px', alignItems: 'center',
            background: header ? colour.fill : 'transparent',
            borderBottom: header || !last
                ? `1px solid ${header ? colour.line : colour.lineFaint}` : 'none',
            ...(header ? label : {}),
        }}>{children}</div>
    );
}

export default function Deployments() {
    const [state, setState] = useState({ loading: true });

    useEffect(() => {
        api.deployments()
            .then((body) => setState({ deployments: body.deployments }))
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
            <div style={{ display: 'flex', justifyContent: 'space-between',
                alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600,
                        letterSpacing: '-0.01em' }}>
                        Deployment specs
                    </h1>
                    <div style={{ fontSize: 13, color: colour.muted }}>
                        What each deployment should be. Immutable once created: a change
                        is a new spec, not an edit to this one.
                    </div>
                </div>

                {/* A spec is always made against a blueprint, so this leads to the
                    list rather than to a form: there is nothing to fill in until
                    a blueprint has said what may be asked. */}
                <Link to="/blueprints" style={{
                    boxSizing: 'border-box', padding: '10px 18px', minHeight: 44,
                    borderRadius: 7, background: colour.ink, color: colour.onRail,
                    fontSize: 14, fontWeight: 500, textDecoration: 'none',
                    display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
                }}>New deployment</Link>
            </div>

            {state.deployments.length === 0 ? (
                <div style={{ ...card, color: colour.muted, fontSize: 13, lineHeight: 1.6 }}>
                    Your team has no deployment specs yet.{' '}
                    <Link to="/blueprints" style={{ color: colour.ink }}>
                        Pick a blueprint
                    </Link>{' '}
                    and answer its questions — that creates one.
                </div>
            ) : (
                <div style={{ background: colour.surface, border: `1px solid ${colour.line}`,
                    borderRadius: 9, overflow: 'hidden' }}>
                    <Row header>
                        <div>SPEC</div>
                        <div>BLUEPRINT</div>
                        <div>STAGES</div>
                        <div>CREATED BY</div>
                        <div>CREATED</div>
                    </Row>
                    {state.deployments.map((spec, index) => (
                        <Row key={spec.id} last={index === state.deployments.length - 1}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                <Link to={`/deployments/${spec.id}`} style={{
                                    fontSize: 14, fontWeight: 500, color: colour.ink,
                                    textDecoration: 'underline', textUnderlineOffset: 2,
                                }}>{spec.id}</Link>
                                <div style={{ ...mono, fontSize: 11, color: colour.muted }}>
                                    {spec.answers.app_name}
                                </div>
                            </div>
                            <div style={{ ...mono, fontSize: 12, color: colour.body }}>
                                {spec.blueprint} v{spec.blueprint_version}
                            </div>
                            <div>
                                <span style={pill('neutral')}>{spec.stages.length}</span>
                            </div>
                            <div style={{ ...mono, fontSize: 12, color: colour.body }}>
                                {spec.created_by}
                            </div>
                            <div style={{ ...mono, fontSize: 11, color: colour.muted }}>
                                {spec.created_at.slice(0, 16).replace('T', ' ')}
                            </div>
                        </Row>
                    ))}
                </div>
            )}
        </>
    );
}
