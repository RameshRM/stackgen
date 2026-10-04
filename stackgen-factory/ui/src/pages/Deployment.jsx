import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { card, colour, label, mono, pill } from '../theme';

/**
 * One deployment spec, and what happened while trying to reach it.
 *
 * The spec is the desired state; the audit below it is the record of the
 * attempt. They are shown together and kept visibly separate, because the
 * document saying what should be true is not evidence that it is.
 */

function decisionPill(decision) {
    const map = { allow: 'pass', pass: 'pass', deny: 'deny', error: 'deny', cannot_tell: 'unknown' };
    return pill(map[decision] || 'neutral');
}

function Section({ title, children, aside }) {
    return (
        <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <div style={label}>{title}</div>
                {aside}
            </div>
            {children}
        </div>
    );
}

function Step({ step, index }) {
    const isGate = Boolean(step.gate);
    return (
        <div style={{
            display: 'flex', gap: 12, alignItems: 'flex-start', padding: '11px 13px',
            background: isGate ? colour.waitFill : colour.surface,
            border: `1px solid ${isGate ? colour.waitLine : colour.line}`,
            borderLeft: `3px solid ${isGate ? '#D9A82B' : '#1D6B4F'}`,
            borderRadius: 8,
        }}>
            <div style={{ ...mono, fontSize: 11, color: colour.muted, paddingTop: 2, width: 14 }}>
                {index + 1}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                    {isGate ? 'Gate' : step.action}{' '}
                    <span style={{ ...mono, fontWeight: 400, fontSize: 13, color: colour.muted }}>
                        {isGate ? step.gate : step.namespace}
                    </span>
                </div>
                <div style={{ fontSize: 12, color: colour.body, lineHeight: 1.5 }}>
                    {isGate
                        ? <>Waits for a <span style={mono}>{step.approver_role}</span>. The
                            workflow ends here; approving starts the next stage.</>
                        : <>Applies this spec's rendered overlay for <span style={mono}>
                            {step.environment}</span>.</>}
                </div>
            </div>
        </div>
    );
}

export default function Deployment() {
    const { id } = useParams();
    const [state, setState] = useState({ loading: true });

    useEffect(() => {
        setState({ loading: true });
        api.deployment(id)
            .then((body) => setState(body))
            .catch((e) => setState({ error: e.message }));
    }, [id]);

    if (state.loading) {
        return <div style={{ color: colour.muted }}>Loading…</div>;
    }
    if (state.error) {
        return (
            <div style={{ ...card, color: colour.denyInk }}>
                {state.error}
                <div style={{ marginTop: 8 }}>
                    <Link to="/deployments" style={{ color: colour.ink }}>← Deployment specs</Link>
                </div>
            </div>
        );
    }

    const { spec, audit, approvals, runs, runs_error: runsError } = state;
    const started = audit.some((entry) => entry.action === 'deploy' && entry.decision === 'allow');

    return (
        <>
            <div style={{ display: 'flex', justifyContent: 'space-between',
                alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <Link to="/deployments"
                        style={{ fontSize: 12, color: colour.muted, textDecoration: 'none' }}>
                        ← Deployment specs
                    </Link>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 11,
                        flexWrap: 'wrap' }}>
                        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600,
                            letterSpacing: '-0.01em' }}>{spec.id}</h1>
                        <span style={{ ...mono, fontSize: 15, color: colour.muted }}>
                            {spec.answers.app_name}
                        </span>
                        <span style={pill(started ? 'pass' : 'wait')}>
                            {started ? 'applied' : 'not yet applied'}
                        </span>
                    </div>
                    <div style={{ fontSize: 13, color: colour.muted }}>
                        From <Link to={`/blueprints/${spec.blueprint}`}
                            style={{ color: colour.body }}>{spec.blueprint}</Link>{' '}
                        v{spec.blueprint_version} · created by{' '}
                        <span style={mono}>{spec.created_by}</span>
                    </div>
                </div>
            </div>

            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 460px', minWidth: 0, display: 'flex',
                    flexDirection: 'column', gap: 12 }}>
                    <Section title="SEQUENCE">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {(spec.sequence || []).map((step, index) =>
                                <Step key={index} step={step} index={index} />)}
                        </div>
                    </Section>

                    <Section title="WHAT WAS RECORDED"
                        aside={<span style={{ fontSize: 11, color: colour.faint }}>
                            {audit.length} entries
                        </span>}>
                        {audit.length === 0 ? (
                            <div style={{ fontSize: 12, color: colour.muted }}>
                                Nothing yet.
                            </div>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                                {audit.map((entry, index) => (
                                    <div key={entry.id} style={{
                                        display: 'flex', gap: 11, alignItems: 'flex-start',
                                        padding: '9px 0',
                                        borderTop: index === 0
                                            ? 'none' : `1px solid ${colour.lineFaint}`,
                                    }}>
                                        <span style={{ ...mono, fontSize: 11, color: colour.faint,
                                            whiteSpace: 'nowrap', paddingTop: 2 }}>
                                            {entry.at.slice(11, 19)}
                                        </span>
                                        <span style={{ ...decisionPill(entry.decision),
                                            flexShrink: 0 }}>
                                            {entry.decision}
                                        </span>
                                        <span style={{ display: 'flex', flexDirection: 'column',
                                            gap: 2, minWidth: 0 }}>
                                            <span style={{ ...mono, fontSize: 12,
                                                color: colour.ink }}>
                                                {entry.action}
                                            </span>
                                            <span style={{ fontSize: 12, color: colour.body,
                                                lineHeight: 1.5 }}>
                                                {entry.reason}
                                            </span>
                                            <span style={{ fontSize: 11, color: colour.faint }}>
                                                {entry.principal_id} ({entry.principal_type})
                                            </span>
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Section>
                </div>

                <div style={{ flex: '0 1 330px', minWidth: 280, display: 'flex',
                    flexDirection: 'column', gap: 12 }}>
                    <Section title="GATES">
                        {approvals.length === 0 ? (
                            <div style={{ fontSize: 12, color: colour.muted, lineHeight: 1.5 }}>
                                No gate has been opened. A gate opens when the stage before
                                it finishes.
                            </div>
                        ) : approvals.map((approval) => (
                            <div key={approval.gate} style={{ display: 'flex',
                                flexDirection: 'column', gap: 4 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between',
                                    gap: 10, alignItems: 'center' }}>
                                    <span style={{ ...mono, fontSize: 12 }}>{approval.gate}</span>
                                    <span style={pill(approval.state === 'approved'
                                        ? 'pass' : approval.state === 'rejected'
                                            ? 'deny' : 'wait')}>
                                        {approval.state}
                                    </span>
                                </div>
                                <div style={{ fontSize: 11, color: colour.muted, lineHeight: 1.5 }}>
                                    {approval.decided_by
                                        ? <>by <span style={mono}>{approval.decided_by}</span></>
                                        : <>needs a <span style={mono}>
                                            {approval.approver_role}</span></>}
                                </div>
                            </div>
                        ))}
                    </Section>

                    <Section title="RUNS">
                        {runsError ? (
                            <div style={{ fontSize: 12, color: colour.unknownInk,
                                lineHeight: 1.5 }}>
                                Unknown, not absent: {runsError}
                            </div>
                        ) : !runs || runs.length === 0 ? (
                            <div style={{ fontSize: 12, color: colour.muted }}>
                                No stage has run yet.
                            </div>
                        ) : runs.map((run) => (
                            <div key={run.dag_run_id} style={{ display: 'flex',
                                justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                                <span style={{ ...mono, fontSize: 11, color: colour.body,
                                    minWidth: 0, overflow: 'hidden',
                                    textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {run.dag_id.replace(spec.id.replace(/-/g, '_') + '_', '')}
                                </span>
                                <span style={pill(
                                    run.state === 'success' ? 'pass'
                                        : run.state === 'failed' ? 'deny' : 'wait')}>
                                    {run.state}
                                </span>
                            </div>
                        ))}
                    </Section>

                    <Section title="ANSWERS">
                        {Object.entries(spec.answers).map(([key, value]) => (
                            <div key={key} style={{ display: 'flex',
                                justifyContent: 'space-between', gap: 12 }}>
                                <span style={{ ...mono, fontSize: 12, color: colour.body }}>
                                    {key}
                                </span>
                                <span style={{ ...mono, fontSize: 12, wordBreak: 'break-all',
                                    textAlign: 'right' }}>
                                    {String(value)}
                                </span>
                            </div>
                        ))}
                    </Section>

                    <Section title="BOUNDARIES">
                        <div style={{ fontSize: 12, color: colour.body, lineHeight: 1.6 }}>
                            may do <span style={mono}>
                                {(spec.boundaries.allowed_actions || []).join(', ')}</span><br />
                            where <span style={mono}>
                                {(spec.boundaries.environments || []).join(', ')}</span>
                        </div>
                        <div style={{ paddingTop: 10, borderTop: `1px solid ${colour.lineFaint}`,
                            fontSize: 12, color: colour.muted, lineHeight: 1.5 }}>
                            These travel with the spec, so a later blueprint edit cannot change
                            how this deployment is judged.
                        </div>
                    </Section>
                </div>
            </div>
        </>
    );
}
