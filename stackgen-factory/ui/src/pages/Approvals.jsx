import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { card, colour, label, mono, pill } from '../theme';

/**
 * Gates waiting on a person.
 *
 * The buttons are shown to everybody. Whether you may pass a gate is the policy
 * engine's answer, not this page's guess, so the refusal comes back from the API
 * with the engine's own reason. Hiding the button would be a worse lie: it would
 * suggest the gate does not exist.
 */
export default function Approvals() {
    const [state, setState] = useState({ loading: true });
    const [busy, setBusy] = useState(null);
    const [outcome, setOutcome] = useState(null);

    function load() {
        api.approvals()
            .then((body) => setState({ approvals: body.approvals }))
            .catch((e) => setState({ error: e.message }));
    }

    useEffect(load, []);

    async function decide(approval, decision) {
        setBusy(approval.gate + approval.spec_id);
        setOutcome(null);
        try {
            const result = await api.decideGate(approval.spec_id, approval.gate, decision);
            setOutcome({
                kind: result.release_error ? 'partial' : 'ok',
                text: result.release_error
                    ? `${approval.gate} ${result.approval.state}, but ${result.release_error}`
                    : result.released
                        ? `${approval.gate} ${result.approval.state}; released ${result.released.dag_id}`
                        : `${approval.gate} ${result.approval.state}; nothing released`,
            });
        } catch (e) {
            setOutcome({ kind: 'refused', text: e.message });
        }
        setBusy(null);
        load();
    }

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
                    Approvals
                </h1>
                <div style={{ fontSize: 13, color: colour.muted }}>
                    A gate is where a workflow ended. Deciding it is what starts the next
                    stage — nothing is waiting on a worker in the meantime.
                </div>
            </div>

            {outcome && (
                <div style={{
                    ...card, padding: '13px 16px',
                    background: outcome.kind === 'ok' ? colour.passFill
                        : outcome.kind === 'partial' ? colour.waitFill : colour.denyFill,
                    borderColor: outcome.kind === 'ok' ? colour.passLine
                        : outcome.kind === 'partial' ? colour.waitLine : colour.denyLine,
                }}>
                    <div style={{
                        fontSize: 13, lineHeight: 1.55,
                        color: outcome.kind === 'ok' ? colour.passInk
                            : outcome.kind === 'partial' ? colour.waitInk : colour.denyInk,
                    }}>
                        <strong>{outcome.kind === 'refused' ? 'Refused.' : ''}</strong>{' '}
                        {outcome.text}
                    </div>
                </div>
            )}

            {state.approvals.length === 0 ? (
                <div style={{ ...card, color: colour.muted, fontSize: 13 }}>
                    No gate is waiting. A gate appears here when the stage before it finishes.
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {state.approvals.map((approval) => {
                        const key = approval.gate + approval.spec_id;
                        return (
                            <div key={key} style={{
                                ...card, display: 'flex', gap: 16, alignItems: 'center',
                                flexWrap: 'wrap', justifyContent: 'space-between',
                            }}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4,
                                    minWidth: 240 }}>
                                    <div style={{ display: 'flex', alignItems: 'baseline',
                                        gap: 10, flexWrap: 'wrap' }}>
                                        <span style={{ fontSize: 15, fontWeight: 500 }}>
                                            {approval.gate}
                                        </span>
                                        <span style={pill('wait')}>pending</span>
                                    </div>
                                    <div style={{ fontSize: 12, color: colour.body }}>
                                        <Link to={`/deployments/${approval.spec_id}`}
                                            style={{ ...mono, color: colour.ink }}>
                                            {approval.spec_id}
                                        </Link>
                                        {' · '}{approval.app_name}
                                        {' · needs a '}<span style={mono}>{approval.approver_role}</span>
                                    </div>
                                    <div style={{ fontSize: 11, color: colour.faint }}>
                                        approving releases <span style={mono}>{approval.next_dag_id}</span>
                                    </div>
                                </div>

                                <div style={{ display: 'flex', gap: 9 }}>
                                    <button type="button" disabled={busy === key}
                                        onClick={() => decide(approval, 'rejected')}
                                        style={{
                                            boxSizing: 'border-box', padding: '10px 16px',
                                            minHeight: 44, borderRadius: 7, cursor: 'pointer',
                                            background: colour.surface, color: colour.denyInk,
                                            border: `1px solid ${colour.denyLine}`,
                                            fontSize: 14, fontWeight: 500,
                                        }}>Reject</button>
                                    <button type="button" disabled={busy === key}
                                        onClick={() => decide(approval, 'approved')}
                                        style={{
                                            boxSizing: 'border-box', padding: '10px 18px',
                                            minHeight: 44, borderRadius: 7, border: 'none',
                                            cursor: 'pointer',
                                            background: busy === key ? colour.faint : colour.ink,
                                            color: colour.onRail, fontSize: 14, fontWeight: 500,
                                        }}>{busy === key ? 'Deciding…' : 'Approve'}</button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </>
    );
}
