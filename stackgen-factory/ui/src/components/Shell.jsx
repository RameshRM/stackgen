import { NavLink } from 'react-router-dom';
import { signOut } from '../auth';
import { colour, font, mono } from '../theme';

const NAV = [
    { to: '/runs', label: 'Runs' },
    { to: '/approvals', label: 'Approvals' },
    { to: '/audit', label: 'Audit' },
    { to: '/deployments', label: 'Deployment specs' },
    { to: '/blueprints', label: 'Blueprints' },
];

function itemStyle({ isActive }) {
    return {
        padding: '9px 10px',
        borderRadius: 6,
        fontSize: 14,
        textDecoration: 'none',
        fontWeight: isActive ? 500 : 400,
        color: isActive ? colour.onRail : colour.onRailIdle,
        background: isActive ? colour.railActive : 'transparent',
    };
}

/**
 * Who you are, taken from a verified token.
 *
 * There used to be a menu here for becoming somebody else, because identity was
 * a header anyone could type. It is a signed token now, so the only way to be
 * somebody else is to sign in as them — which is the point, and the reason the
 * menu is gone rather than hidden.
 */
function Who({ user }) {
    return (
        <div style={{
            marginTop: 'auto', padding: 10, borderTop: `1px solid ${colour.railActive}`,
            display: 'flex', flexDirection: 'column', gap: 8,
        }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ fontSize: 13, color: colour.onRail }}>{user?.id || '…'}</div>
                <div style={{ ...mono, fontSize: 11, color: colour.onRailMuted }}>
                    {user
                        ? `team ${user.team}${user.roles.length ? ' · ' + user.roles.join(', ') : ' · no roles'}`
                        : ''}
                </div>
            </div>

            {user && (
                <button type="button"
                    onClick={() => { signOut(); window.location.reload(); }}
                    style={{
                        boxSizing: 'border-box', width: '100%', padding: '7px 8px',
                        minHeight: 34, borderRadius: 6, cursor: 'pointer',
                        background: 'transparent', color: colour.onRailIdle,
                        border: `1px solid ${colour.railActive}`, fontSize: 12,
                    }}>Sign out</button>
            )}
        </div>
    );
}

export default function Shell({ user, children }) {
    return (
        <div style={{
            minHeight: '100vh', display: 'flex',
            background: colour.ground, fontFamily: font.sans, color: colour.ink,
        }}>
            <div style={{
                width: 232, flexShrink: 0, boxSizing: 'border-box', padding: '24px 16px',
                background: colour.rail, display: 'flex', flexDirection: 'column', gap: 28,
            }}>
                <div style={{ padding: '0 8px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.09em', color: colour.onRail }}>
                        FACTORY
                    </div>
                    <div style={{ fontSize: 12, color: colour.onRailMuted }}>
                        Operations control plane
                    </div>
                </div>

                <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {NAV.map((item) => (
                        <NavLink key={item.to} to={item.to} style={itemStyle}>{item.label}</NavLink>
                    ))}
                </nav>

                <Who user={user} />
            </div>

            <div style={{
                flexGrow: 1, boxSizing: 'border-box', padding: '26px 32px',
                display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0,
            }}>
                {children}
            </div>
        </div>
    );
}
