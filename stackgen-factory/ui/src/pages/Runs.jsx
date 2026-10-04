import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { card, colour, label, mono, pill } from '../theme';

/**
 * What happened while trying to reach the specs.
 *
 * Run state comes from the orchestrator, which owns it. If it cannot be reached
 * this page says the runs are unknown rather than showing an empty list, because
 * "none" and "we could not ask" are different facts.
 */

function statePill(state) {
    const map = { success: 'pass', failed: 'deny', running: 'wait', queued: 'wait' };
    return pill(map[state] || 'unknown');
}

const COLUMNS = '1fr 1fr 110px 170px';

function Row({ children, header, last }) {
    return (
        <div style={{
            display: 'grid', gridTemplateColumns: COLUMNS, gap: 14,
            padding: header ? '11px 18px' : '14px 18px', alignItems: 'center',
            background: header ? colour.fill : 'transparent',
            borderBottom: header || !last
                ? `1px solid ${header ? colour.line : colour.lineFaint}` : 'none',
            ...(header ? label : {}),
        }}>{children}</div>
    );
}

export default function Runs() {
    const [state, setState] = useState({ loading: true });

    useEffect(() => {
        api.runs()
            .then((body) => setState({ runs: body.runs, error: body.runs_error }))
            .catch((e) => setState({ fatal: e.message }));
    }, []);

    if (state.loading) {
        return <div style={{ color: colour.muted }}>Loading…</div>;
    }
    if (state.fatal) {
        return <div style={{ color: colour.denyInk }}>{state.fatal}</div>;
    }

    return (
        <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: '-0.01em' }}>
                    Runs
                </h1>
                <div style={{ fontSize: 13, color: colour.muted }}>
                    A run is an attempt to reach a deployment spec. It is not the state of
                    the cluster — it is what happened while trying.
                </div>
            </div>

            {state.error && (
                <div style={{ ...card, padding: '13px 16px', background: colour.unknownFill,
                    borderColor: colour.unknownLine }}>
                    <div style={{ fontSize: 13, color: colour.unknownInk, lineHeight: 1.55 }}>
                        <strong>Runs are unknown, not absent.</strong> {state.error}
                    </div>
                </div>
            )}

            {state.runs.length === 0 ? (
                <div style={{ ...card, color: colour.muted, fontSize: 13 }}>
                    {state.error
                        ? 'Nothing could be read from the orchestrator.'
                        : 'No stage has run yet.'}
                </div>
            ) : (
                <div style={{ background: colour.surface, border: `1px solid ${colour.line}`,
                    borderRadius: 9, overflow: 'hidden' }}>
                    <Row header>
                        <div>RUN</div>
                        <div>STAGE</div>
                        <div>STATE</div>
                        <div>STARTED</div>
                    </Row>
                    {state.runs.map((run, index) => (
                        <Row key={run.dag_run_id} last={index === state.runs.length - 1}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2,
                                minWidth: 0 }}>
                                <Link to={`/deployments/${run.spec_id}`} style={{
                                    fontSize: 13, fontWeight: 500, color: colour.ink,
                                    textDecoration: 'underline', textUnderlineOffset: 2,
                                }}>{run.spec_id}</Link>
                                <span style={{ ...mono, fontSize: 11, color: colour.muted }}>
                                    {run.app_name}
                                </span>
                            </div>
                            <div style={{ ...mono, fontSize: 12, color: colour.body,
                                wordBreak: 'break-all' }}>
                                {run.dag_id}
                            </div>
                            <div><span style={statePill(run.state)}>{run.state}</span></div>
                            <div style={{ ...mono, fontSize: 11, color: colour.muted }}>
                                {run.started_at
                                    ? run.started_at.slice(0, 19).replace('T', ' ')
                                    : '—'}
                            </div>
                        </Row>
                    ))}
                </div>
            )}
        </>
    );
}
