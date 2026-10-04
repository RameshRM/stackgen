import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { card, colour, label, mono, pill } from '../theme';

/**
 * Answer a blueprint's questions, and the deployment spec exists.
 *
 * What is absent from this form is the point. Team and namespace are not asked:
 * the team comes from the session and the namespace is derived from it, so a
 * developer cannot point a deployment at another team. Overrides appear only
 * where the blueprint declared a bound, and the bound is shown next to the
 * field rather than discovered by being refused.
 */

const field = {
    boxSizing: 'border-box',
    width: '100%',
    padding: '9px 11px',
    minHeight: 40,
    fontSize: 13,
    fontFamily: mono.fontFamily,
    color: colour.ink,
    background: colour.surface,
    border: `1px solid ${colour.line}`,
    borderRadius: 6,
};

function Question({ question, value, onChange }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <label htmlFor={question.id} style={{ ...mono, fontSize: 12, color: colour.body }}>
                    {question.id}
                </label>
                <span style={{ fontSize: 11, color: colour.faint }}>{question.type}</span>
            </div>
            <input
                id={question.id}
                style={field}
                type={question.type === 'number' ? 'number' : 'text'}
                value={value ?? ''}
                placeholder={question.default !== undefined ? String(question.default) : ''}
                onChange={(event) => onChange(question.id, event.target.value)}
            />
        </div>
    );
}

/** An override the blueprint permits, shown with the bound it must stay inside. */
function Override({ name, setting, value, onChange }) {
    if (!setting || typeof setting !== 'object') {
        return null;
    }
    const max = setting.max;
    const values = setting.values;
    if (max === undefined && !values) {
        return null;                    // not overridable, so do not offer it
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <label htmlFor={name} style={{ ...mono, fontSize: 12, color: colour.body }}>
                    {name}
                </label>
                <span style={{ fontSize: 11, color: colour.faint }}>
                    {values ? `one of ${values.join(', ')}` : `1 to ${max}`}
                </span>
            </div>
            {values ? (
                <select id={name} style={field} value={value ?? ''}
                    onChange={(event) => onChange(name, event.target.value)}>
                    <option value="">blueprint default</option>
                    {values.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
            ) : (
                <input id={name} style={field} type="number" min={1} max={max}
                    value={value ?? ''} placeholder="blueprint default"
                    onChange={(event) => onChange(name, event.target.value)} />
            )}
        </div>
    );
}

export default function Submit() {
    const { name } = useParams();
    const navigate = useNavigate();
    const [state, setState] = useState({ loading: true });
    const [me, setMe] = useState(null);
    const [answers, setAnswers] = useState({});
    const [target, setTarget] = useState('k8s');
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        Promise.all([api.blueprint(name), api.me()])
            .then(([blueprint, principal]) => { setState(blueprint); setMe(principal); })
            .catch((e) => setState({ error: e.message }));
    }, [name]);

    function change(key, raw) {
        setAnswers((current) => {
            const next = { ...current };
            if (raw === '') {
                delete next[key];        // absent means "use the blueprint's default"
            } else {
                next[key] = raw;
            }
            return next;
        });
    }

    async function create(event) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const created = await api.createDeployment(
                name, coerce(answers, state.blueprint), target);
            navigate(`/deployments/${created.spec.id}`);
        } catch (e) {
            setError(e.message);
            setBusy(false);
        }
    }

    if (state.loading) {
        return <div style={{ color: colour.muted }}>Loading…</div>;
    }
    if (state.error) {
        return <div style={{ ...card, color: colour.denyInk }}>{state.error}</div>;
    }

    const blueprint = state.blueprint;
    const workload = blueprint.workload || {};
    const environments = (blueprint.boundaries && blueprint.boundaries.environments) || [];

    return (
        <form onSubmit={create} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <Link to={`/blueprints/${name}`}
                    style={{ fontSize: 12, color: colour.muted, textDecoration: 'none' }}>
                    ← {name}
                </Link>
                <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: '-0.01em' }}>
                    New deployment
                </h1>
                <div style={{ fontSize: 13, color: colour.muted }}>
                    Answering these creates the deployment spec. There is no separate
                    run button: declaring the desired state is the instruction to reach it.
                </div>
            </div>

            {error && (
                <div style={{ ...card, padding: '13px 16px', background: '#FCF3F0',
                    borderColor: colour.denyLine }}>
                    <div style={{ fontSize: 13, color: colour.denyInk, lineHeight: 1.55 }}>
                        <strong>Refused.</strong> {error}
                    </div>
                </div>
            )}

            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 420px', minWidth: 0, display: 'flex',
                    flexDirection: 'column', gap: 12 }}>
                    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 13 }}>
                        <div style={label}>ANSWERS</div>
                        {(blueprint.questions || []).map((question) => (
                            <Question key={question.id} question={question}
                                value={answers[question.id]} onChange={change} />
                        ))}
                    </div>

                    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 13 }}>
                        <div style={label}>YOUR CHOICES, WITHIN THE BLUEPRINT'S LIMITS</div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between',
                                gap: 12 }}>
                                <label htmlFor="target"
                                    style={{ ...mono, fontSize: 12, color: colour.body }}>
                                    type
                                </label>
                                <span style={{ fontSize: 11, color: colour.faint }}>
                                    {(state.targets || []).length === 1
                                        ? 'the only target that can be realised'
                                        : 'the kind of place this lands'}
                                </span>
                            </div>
                            <select id="target" style={field} value={target}
                                onChange={(event) => setTarget(event.target.value)}>
                                {(state.targets || ['k8s']).map((t) => (
                                    <option key={t} value={t}>{t}</option>
                                ))}
                            </select>
                        </div>

                        <Override name="replicas" setting={workload.replicas}
                            value={answers.replicas} onChange={change} />
                        <Override name="memory" setting={workload.memory}
                            value={answers.memory} onChange={change} />
                        <div style={{ paddingTop: 4, fontSize: 12, color: colour.muted,
                            lineHeight: 1.5 }}>
                            The target is recorded on this spec, not on the blueprint: one
                            blueprint serves many deployments and they need not land in the
                            same kind of place.
                            <br /><br />
                            An override applies to {environments[environments.length - 1]} only.
                            Earlier environments exist to be tested in, not to be sized.
                        </div>
                    </div>
                </div>

                <div style={{ flex: '0 1 320px', minWidth: 280, display: 'flex',
                    flexDirection: 'column', gap: 12 }}>
                    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 11 }}>
                        <div style={label}>NOT ASKED</div>
                        <Derived name="team" value={me ? me.team : '…'}
                            why="from your session" />
                        {environments.map((environment) => (
                            <Derived key={environment} name={`namespace (${environment})`}
                                value={me ? `${me.team}-${environment}` : '…'}
                                why="derived from team and environment" />
                        ))}
                        <div style={{ paddingTop: 10, borderTop: `1px solid ${colour.lineFaint}`,
                            fontSize: 12, color: colour.muted, lineHeight: 1.5 }}>
                            Nothing here is a field, because a field is something that can be
                            set to another team's value.
                        </div>
                    </div>

                    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 9 }}>
                        <div style={label}>WHAT WILL HAPPEN</div>
                        {(blueprint.sequence || []).map((step, index) => (
                            <div key={index} style={{ display: 'flex', gap: 9, fontSize: 12,
                                color: colour.body }}>
                                <span style={{ ...mono, color: colour.faint, width: 12 }}>
                                    {index + 1}
                                </span>
                                {step.gate ? (
                                    <span>
                                        <span style={pill('wait')}>gate</span>{' '}
                                        waits for a {step.approver_role}
                                    </span>
                                ) : (
                                    <span>{step.action} to <span style={mono}>{step.environment}</span></span>
                                )}
                            </div>
                        ))}
                    </div>

                    <button type="submit" disabled={busy} style={{
                        boxSizing: 'border-box', padding: '11px 18px', minHeight: 44,
                        borderRadius: 7, border: 'none', cursor: busy ? 'default' : 'pointer',
                        background: busy ? colour.faint : colour.ink,
                        color: colour.onRail, fontSize: 14, fontWeight: 500,
                    }}>
                        {busy ? 'Creating…' : 'Create deployment spec'}
                    </button>
                </div>
            </div>
        </form>
    );
}

function Derived({ name, value, why }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ ...mono, fontSize: 12, color: colour.body }}>{name}</span>
                <span style={{ ...mono, fontSize: 12 }}>{value}</span>
            </div>
            <div style={{ fontSize: 11, color: colour.faint }}>{why}</div>
        </div>
    );
}

/**
 * Inputs are strings; the blueprint says which are numbers.
 *
 * Sending "2" where a number is expected would either be refused by the bound
 * check or stored as a string in the spec, and a spec holding "2" instead of 2
 * is a document that lies about its own type.
 */
function coerce(supplied, blueprint) {
    const numeric = new Set(
        (blueprint.questions || [])
            .filter((question) => question.type === 'number')
            .map((question) => question.id));
    numeric.add('replicas');

    const out = {};
    Object.keys(supplied).forEach((key) => {
        out[key] = numeric.has(key) ? Number(supplied[key]) : supplied[key];
    });
    return out;
}
