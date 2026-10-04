import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { card, colour, label, mono, pill } from '../theme';

function Section({ title, children }) {
    return (
        <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={label}>{title}</div>
            {children}
        </div>
    );
}

/** One step of the sequence. A gate is drawn differently because it is not work. */
function Step({ step, index }) {
    const isGate = Boolean(step.gate);
    return (
        <div style={{
            display: 'flex', gap: 12, alignItems: 'flex-start',
            padding: '11px 13px',
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
                    {isGate ? 'Gate' : step.action}
                    {' '}
                    <span style={{ ...mono, fontWeight: 400, fontSize: 13, color: colour.muted }}>
                        {isGate ? step.gate : step.environment}
                    </span>
                </div>
                <div style={{ fontSize: 12, color: colour.body, lineHeight: 1.5 }}>
                    {isGate
                        ? (step.approver_role
                            ? <>Waits for a <span style={mono}>{step.approver_role}</span>. The workflow ends here and the next stage is triggered by the approval.</>
                            : <span style={{ color: colour.waitInk }}>Names no approver role, so anyone signed in could pass it.</span>)
                        : <>Applies the deployment spec's rendered overlay for <span style={mono}>{step.environment}</span>.</>}
                </div>
            </div>
        </div>
    );
}

/** A workload setting: the default, and any environment that overrides it. */
function Setting({ name, setting, environments, unit }) {
    if (setting === undefined) return null;

    const isObject = setting && typeof setting === 'object';
    const fallback = isObject ? setting.default : setting;
    const bounds = isObject
        ? [
            setting.max !== undefined ? `max ${setting.max}` : null,
            setting.values ? `one of ${setting.values.join(', ')}` : null,
        ].filter(Boolean)
        : [];

    const show = (value) => (value && typeof value === 'object')
        ? `${value.requests} → ${value.limits}`
        : `${value}${unit || ''}`;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ ...mono, fontSize: 12, color: colour.body }}>{name}</span>
                <span style={{ ...mono, fontSize: 12 }}>{show(fallback)}</span>
            </div>
            {environments.filter((e) => isObject && setting[e] !== undefined).map((e) => (
                <div key={e} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, paddingLeft: 12 }}>
                    <span style={{ fontSize: 11, color: colour.muted }}>{e} overrides</span>
                    <span style={{ ...mono, fontSize: 11, color: colour.body }}>{show(setting[e])}</span>
                </div>
            ))}
            {bounds.length > 0 && (
                <div style={{ fontSize: 11, color: colour.faint, paddingLeft: 12 }}>
                    a developer may choose within: {bounds.join(', ')}
                </div>
            )}
        </div>
    );
}

export default function Blueprint() {
    const { name } = useParams();
    const [state, setState] = useState({ loading: true });

    useEffect(() => {
        setState({ loading: true });
        api.blueprint(name)
            .then((data) => setState(data))
            .catch((error) => setState({ error: error.message }));
    }, [name]);

    if (state.loading) return <div style={{ color: colour.muted }}>Loading…</div>;
    if (state.error) {
        return (
            <div style={{ ...card, color: colour.denyInk }}>
                {state.error}
                <div style={{ marginTop: 8 }}>
                    <Link to="/blueprints" style={{ color: colour.ink }}>← Blueprints</Link>
                </div>
            </div>
        );
    }

    const bp = state.blueprint;
    const environments = (bp.boundaries && bp.boundaries.environments) || [];
    const { errors, warnings } = state.validation;

    return (
        <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <Link to="/blueprints" style={{ fontSize: 12, color: colour.muted, textDecoration: 'none' }}>
                        ← Blueprints
                    </Link>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 11 }}>
                        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: '-0.01em' }}>
                            {bp.name}
                        </h1>
                        <span style={{ ...mono, fontSize: 15, color: colour.muted }}>v{bp.version}</span>
                        <span style={pill(bp.visibility === 'shared' ? 'pass' : 'neutral')}>
                            {bp.visibility === 'shared' ? 'shared' : 'team only'}
                        </span>
                    </div>
                    <div style={{ fontSize: 13, color: colour.muted }}>
                        Owned by <span style={mono}>{bp.owner_team}</span>
                        {!state.may_author && ' · editing requires platform-admin'}
                    </div>
                </div>

                <div style={{ display: 'flex', gap: 9 }}>
                    {state.may_author && (
                        <Link to={`/blueprints/${bp.name}/edit`} style={{
                            boxSizing: 'border-box', padding: '10px 18px', minHeight: 44,
                            borderRadius: 7, background: colour.surface, color: colour.ink,
                            border: `1px solid ${colour.line}`,
                            fontSize: 14, fontWeight: 500, textDecoration: 'none',
                            display: 'inline-flex', alignItems: 'center',
                        }}>Edit</Link>
                    )}
                    <Link to={`/submit/${bp.name}`} style={{
                        boxSizing: 'border-box', padding: '10px 18px', minHeight: 44,
                        borderRadius: 7, background: colour.ink, color: colour.onRail,
                        fontSize: 14, fontWeight: 500, textDecoration: 'none',
                        display: 'inline-flex', alignItems: 'center',
                    }}>Use this blueprint</Link>
                </div>
            </div>

            {(errors.length > 0 || warnings.length > 0) && (
                <div style={{
                    ...card, padding: '13px 16px',
                    background: errors.length ? '#FCF3F0' : '#FFFDF6',
                    borderColor: errors.length ? colour.denyLine : colour.waitLine,
                }}>
                    <div style={{ fontSize: 13, color: errors.length ? colour.denyInk : colour.waitInk, lineHeight: 1.55 }}>
                        <strong>{errors.length ? 'This blueprint cannot be published.' : 'Published, with a warning.'}</strong>
                        {' '}
                        {[...errors, ...warnings].map((p) => p.message).join('. ')}.
                    </div>
                </div>
            )}

            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 460px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <Section title="SEQUENCE">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {(bp.sequence || []).map((step, i) => (
                                <Step key={i} step={step} index={i} />
                            ))}
                        </div>
                    </Section>

                    <Section title="ASKED OF THE DEVELOPER">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {(bp.questions || []).map((q) => (
                                <div key={q.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                                    <span style={{ ...mono, fontSize: 12, color: colour.body }}>{q.id}</span>
                                    <span style={{ fontSize: 12, color: colour.muted }}>
                                        {q.type}{q.default !== undefined ? ` · default ${q.default}` : ''}
                                    </span>
                                </div>
                            ))}
                        </div>
                        <div style={{ paddingTop: 10, borderTop: `1px solid ${colour.lineFaint}`, fontSize: 12, color: colour.muted, lineHeight: 1.5 }}>
                            The answers, plus this blueprint, become a deployment spec. The team
                            and namespace are not asked — they come from the session and the step.
                        </div>
                    </Section>
                </div>

                <div style={{ flex: '0 1 330px', minWidth: 280, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <Section title="BOUNDARIES">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                <div style={{ fontSize: 11, color: colour.muted }}>may do</div>
                                <div style={{ ...mono, fontSize: 12 }}>
                                    {(bp.boundaries.allowed_actions || []).join(', ')}
                                </div>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                <div style={{ fontSize: 11, color: colour.muted }}>where</div>
                                <div style={{ ...mono, fontSize: 12 }}>{environments.join(', ')}</div>
                            </div>
                        </div>
                        <div style={{ paddingTop: 10, borderTop: `1px solid ${colour.lineFaint}`, fontSize: 12, color: colour.muted, lineHeight: 1.5 }}>
                            Anything outside this is refused at runtime, whoever asks.
                        </div>
                    </Section>

                    <Section title="WORKLOAD">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ ...mono, fontSize: 12, color: colour.body }}>port</span>
                                <span style={{ ...mono, fontSize: 12 }}>{bp.workload.port}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ ...mono, fontSize: 12, color: colour.body }}>health</span>
                                <span style={{ ...mono, fontSize: 12 }}>{bp.workload.health_path}</span>
                            </div>
                            <Setting name="replicas" setting={bp.workload.replicas} environments={environments} />
                            <Setting name="cpu" setting={bp.workload.cpu} environments={environments} />
                            <Setting name="memory" setting={bp.workload.memory} environments={environments} />
                        </div>
                    </Section>

                    <Section title="RECORDED, AND ACCEPTED">
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {(bp.record || []).map((r) => (
                                <span key={r} style={{
                                    ...mono, fontSize: 11, color: colour.body, background: colour.fill,
                                    border: `1px solid #E3E0D9`, borderRadius: 4, padding: '2px 7px',
                                }}>{r}</span>
                            ))}
                        </div>
                        {(bp.acceptance || []).map((a) => (
                            <div key={a.id} style={{ fontSize: 12, color: colour.body, lineHeight: 1.5 }}>
                                <span style={mono}>{a.expression}</span> over {a.window}, from {a.source}
                            </div>
                        ))}
                    </Section>
                </div>
            </div>
        </>
    );
}
