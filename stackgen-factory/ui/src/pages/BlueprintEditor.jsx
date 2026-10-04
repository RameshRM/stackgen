import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { card, colour, label, mono, pill } from '../theme';

/**
 * Authoring a blueprint.
 *
 * Two things are deliberately not editable. The version, because it is derived
 * from what the edit did — an author who could type it could promise a developer
 * that nothing was taken away while taking something away. And the published
 * document, because a deployment spec cites a version: publishing an edit
 * creates the next version rather than changing the one that was cited.
 *
 * Review runs as you type, against the same validation that publishing uses, so
 * the editor cannot say yes to something publish will refuse.
 */

const STARTER = `name: new-blueprint
owner_team: platform
visibility: shared

questions:
  - id: app_name
    type: string
  - id: image
    type: string

boundaries:
  allowed_actions: [deploy]
  environments: [staging]

workload:
  port: 3000
  health_path: /health
  replicas:
    default: 1
    max: 3
  cpu:
    default: { requests: 50m, limits: 200m }
  memory:
    default: { requests: 64Mi, limits: 128Mi }
    values: [128Mi, 256Mi]

sequence:
  - action: deploy
    environment: staging

record: [image]

acceptance:
  - id: error_rate
    source: metrics
    expression: error_rate < 0.01
    window: 2m
`;

function levelPill(level) {
    return pill(level === 'major' ? 'deny' : level === 'minor' ? 'wait' : 'neutral');
}

export default function BlueprintEditor() {
    const params = useParams();
    const navigate = useNavigate();
    const creating = params.name === undefined;

    const [name, setName] = useState('');
    const [yaml, setYaml] = useState(creating ? STARTER : '');
    const [state, setState] = useState({ loading: !creating });
    const [review, setReview] = useState(null);
    const [notice, setNotice] = useState(null);
    const [busy, setBusy] = useState(false);
    const timer = useRef(null);

    useEffect(() => {
        if (creating) { return; }
        api.authoring(params.name)
            .then((body) => {
                setName(params.name);
                setYaml(body.draft ? body.draft.yaml : (body.published ? body.published.yaml : STARTER));
                setState(body);
            })
            .catch((e) => setState({ error: e.message }));
    }, [params.name, creating]);

    // Review is debounced rather than run per keystroke: it parses a document
    // and diffs it against the published one, and doing that mid-word tells the
    // author their half-typed key is invalid, which is noise, not help.
    const runReview = useCallback((forName, text) => {
        if (!forName) { return; }
        api.reviewDraft(forName, text).then(setReview).catch(() => setReview(null));
    }, []);

    useEffect(() => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => runReview(name || params.name, yaml), 400);
        return () => clearTimeout(timer.current);
    }, [yaml, name, params.name, runReview]);

    async function save() {
        setBusy(true);
        setNotice(null);
        try {
            await api.saveDraft(name, yaml);
            setNotice({ kind: 'ok', text: 'Draft saved. Nothing is published yet.' });
            if (creating) { navigate(`/blueprints/${name}/edit`, { replace: true }); }
        } catch (e) {
            setNotice({ kind: 'bad', text: e.message });
        }
        setBusy(false);
    }

    async function publish() {
        setBusy(true);
        setNotice(null);
        try {
            await api.saveDraft(name, yaml);
            const result = await api.publishBlueprint(name);
            navigate(`/blueprints/${result.name}`);
        } catch (e) {
            setNotice({ kind: 'bad', text: e.message });
            setBusy(false);
        }
    }

    if (state.loading) {
        return <div style={{ color: colour.muted }}>Loading…</div>;
    }
    if (state.error) {
        return <div style={{ ...card, color: colour.denyInk }}>{state.error}</div>;
    }

    const errors = review ? review.validation.errors : [];
    const warnings = review ? review.validation.warnings : [];
    const canPublish = Boolean(name) && review && review.validation.publishable && !busy;

    return (
        <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <Link to="/blueprints" style={{ fontSize: 12, color: colour.muted,
                    textDecoration: 'none' }}>← Blueprints</Link>
                <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: '-0.01em' }}>
                    {creating ? 'New blueprint' : `Editing ${params.name}`}
                </h1>
                <div style={{ fontSize: 13, color: colour.muted }}>
                    A blueprint governs an operation. Publishing it creates a new version —
                    the one already published keeps saying what it said.
                </div>
            </div>

            {notice && (
                <div style={{ ...card, padding: '13px 16px',
                    background: notice.kind === 'ok' ? colour.passFill : colour.denyFill,
                    borderColor: notice.kind === 'ok' ? colour.passLine : colour.denyLine }}>
                    <div style={{ fontSize: 13, lineHeight: 1.55,
                        color: notice.kind === 'ok' ? colour.passInk : colour.denyInk }}>
                        {notice.text}
                    </div>
                </div>
            )}

            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 480px', minWidth: 0, display: 'flex',
                    flexDirection: 'column', gap: 12 }}>
                    {creating && (
                        <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <label htmlFor="bp-name" style={label}>NAME</label>
                            <input id="bp-name" value={name} placeholder="deploy-worker"
                                onChange={(e) => setName(e.target.value.trim())}
                                style={{
                                    boxSizing: 'border-box', width: '100%', padding: '9px 11px',
                                    minHeight: 40, fontSize: 13, fontFamily: mono.fontFamily,
                                    border: `1px solid ${colour.line}`, borderRadius: 6,
                                    background: colour.surface, color: colour.ink,
                                }} />
                            <div style={{ fontSize: 11, color: colour.faint }}>
                                lower case letters, digits and hyphens · becomes
                                blueprints/{name || 'name'}.yaml
                            </div>
                        </div>
                    )}

                    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8,
                        padding: 0, overflow: 'hidden' }}>
                        <div style={{ ...label, padding: '14px 16px 0' }}>DOCUMENT</div>
                        <textarea value={yaml} onChange={(e) => setYaml(e.target.value)}
                            spellCheck={false} rows={26} style={{
                                boxSizing: 'border-box', width: '100%', border: 'none',
                                borderTop: `1px solid ${colour.lineFaint}`,
                                padding: '12px 16px', resize: 'vertical',
                                fontFamily: mono.fontFamily, fontSize: 12.5, lineHeight: 1.65,
                                color: colour.ink, background: colour.surface, outline: 'none',
                            }} />
                    </div>
                </div>

                <div style={{ flex: '0 1 330px', minWidth: 280, display: 'flex',
                    flexDirection: 'column', gap: 12 }}>
                    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={label}>WHAT PUBLISHING WOULD DO</div>
                        {!review ? (
                            <div style={{ fontSize: 12, color: colour.muted }}>
                                {name ? 'Checking…' : 'Name it to see the version.'}
                            </div>
                        ) : (
                            <>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                                    <span style={{ ...mono, fontSize: 20, fontWeight: 600 }}>
                                        {review.next ? review.next.version : '—'}
                                    </span>
                                    {review.next && (
                                        <span style={levelPill(review.next.level)}>
                                            {review.next.level}
                                        </span>
                                    )}
                                    {review.current_version && (
                                        <span style={{ fontSize: 11, color: colour.faint }}>
                                            from {review.current_version}
                                        </span>
                                    )}
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                                    {(review.next ? review.next.reasons : []).map((reason, i) => (
                                        <div key={i} style={{ fontSize: 12, color: colour.body,
                                            lineHeight: 1.5 }}>· {reason}</div>
                                    ))}
                                </div>
                                <div style={{ paddingTop: 9,
                                    borderTop: `1px solid ${colour.lineFaint}`,
                                    fontSize: 11, color: colour.muted, lineHeight: 1.5 }}>
                                    The version is derived from the change, not chosen. A major
                                    means something a developer could do, they no longer can.
                                </div>
                            </>
                        )}
                    </div>

                    {(errors.length > 0 || warnings.length > 0) && (
                        <div style={{ ...card,
                            background: errors.length ? '#FCF3F0' : '#FFFDF6',
                            borderColor: errors.length ? colour.denyLine : colour.waitLine,
                            display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <div style={label}>{errors.length ? 'CANNOT PUBLISH' : 'WARNING'}</div>
                            {[...errors, ...warnings].map((problem, i) => (
                                <div key={i} style={{ fontSize: 12, lineHeight: 1.55,
                                    color: errors.length ? colour.denyInk : colour.waitInk }}>
                                    <span style={mono}>{problem.field}</span> — {problem.message}
                                </div>
                            ))}
                        </div>
                    )}

                    {state.history && state.history.length > 0 && (
                        <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <div style={label}>PUBLISHED</div>
                            {state.history.map((entry) => (
                                <div key={entry.version} style={{ display: 'flex',
                                    justifyContent: 'space-between', gap: 10 }}>
                                    <span style={{ ...mono, fontSize: 12 }}>{entry.version}</span>
                                    <span style={{ fontSize: 11, color: colour.muted }}>
                                        {entry.authored_by || 'written by hand'}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}

                    <div style={{ display: 'flex', gap: 9 }}>
                        <button type="button" onClick={save} disabled={!name || busy}
                            style={{
                                flex: 1, boxSizing: 'border-box', padding: '11px 16px',
                                minHeight: 44, borderRadius: 7, cursor: 'pointer',
                                background: colour.surface, color: colour.ink,
                                border: `1px solid ${colour.line}`, fontSize: 14, fontWeight: 500,
                            }}>Save draft</button>
                        <button type="button" onClick={publish} disabled={!canPublish}
                            style={{
                                flex: 1, boxSizing: 'border-box', padding: '11px 16px',
                                minHeight: 44, borderRadius: 7, border: 'none',
                                cursor: canPublish ? 'pointer' : 'default',
                                background: canPublish ? colour.ink : colour.faint,
                                color: colour.onRail, fontSize: 14, fontWeight: 500,
                            }}>
                            {busy ? 'Working…' : `Publish ${review && review.next ? review.next.version : ''}`}
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}
