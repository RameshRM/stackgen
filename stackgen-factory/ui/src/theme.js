/**
 * The look, in one place.
 *
 * Status colours differ in lightness as well as hue, so they survive greyscale
 * and do not rely on separating red from green.
 */
export const colour = {
    ground: '#F7F6F3',
    surface: '#FFFFFF',
    rail: '#141413',
    railActive: '#2E2D29',

    ink: '#1A1917',
    body: '#4A4843',
    muted: '#6B6862',
    faint: '#8C8880',
    onRail: '#F7F6F3',
    onRailMuted: '#9B968D',
    onRailIdle: '#A8A49C',

    line: '#DEDBD4',
    lineFaint: '#EDEAE4',
    fill: '#F2F0EB',

    passInk: '#14543C', passFill: '#DEEBE3', passLine: '#CFE2D7',
    denyInk: '#7C2B12', denyFill: '#F6DFD7', denyLine: '#EFD5CC',
    waitInk: '#6E5008', waitFill: '#FBF1D9', waitLine: '#EBDCAE',
    unknownInk: '#2F4657', unknownFill: '#E4EAF0', unknownLine: '#D3DDE6',
};

export const font = {
    sans: "'IBM Plex Sans', system-ui, sans-serif",
    mono: "'IBM Plex Mono', ui-monospace, monospace",
};

export const mono = { fontFamily: font.mono };

export function pill(kind) {
    const map = {
        pass: [colour.passFill, colour.passInk],
        deny: [colour.denyFill, colour.denyInk],
        wait: [colour.waitFill, colour.waitInk],
        unknown: [colour.unknownFill, colour.unknownInk],
        neutral: [colour.fill, colour.body],
    };
    const [background, color] = map[kind] || map.neutral;
    return {
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 5,
        fontSize: 12,
        fontWeight: 500,
        background,
        color,
    };
}

export const card = {
    boxSizing: 'border-box',
    padding: 16,
    background: colour.surface,
    border: `1px solid ${colour.line}`,
    borderRadius: 9,
};

export const label = {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.07em',
    color: colour.muted,
};
