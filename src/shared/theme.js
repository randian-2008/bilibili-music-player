(function (root) {
    'use strict';

    const STORAGE_KEY = 'bpl_theme';
    const DEFAULT_ID = 'starry';
    const themes = [
        {
            id: 'jade', name: '古典墨玉',
            swatch: 'linear-gradient(135deg,#080c09 0%,#1d3f2b 68%,#d9e1cf 100%)',
            vars: {
                '--bpl-page': '#0b120e', '--bpl-surface': '#111d16', '--bpl-raised': '#1a2e22',
                '--bpl-control': '#253d2e', '--bpl-hover': '#304e3b', '--bpl-border': '#1a2a20',
                '--bpl-border-strong': '#58695d', '--bpl-border-hover': '#a9c0aa',
                '--bpl-text': '#ecefe6', '--bpl-text-strong': '#fffdf3', '--bpl-muted': '#cbd3c5',
                '--bpl-subtle': '#a8b4a7', '--bpl-faint': '#7f9184', '--bpl-accent': '#9fc5a8',
                '--bpl-accent-hover': '#c5dac5', '--bpl-accent-soft': 'rgba(159,197,168,.13)',
                '--bpl-accent-border': 'rgba(159,197,168,.54)', '--bpl-on-accent': '#102016',
                '--bpl-danger': '#dca1a0', '--bpl-danger-strong': '#ce7c7b', '--bpl-danger-soft': '#352323',
                '--bpl-track': '#405846', '--bpl-scroll': '#809e84',
                '--bpl-control-soft': 'rgba(224,231,216,.08)', '--bpl-control-soft-hover': 'rgba(224,231,216,.16)',
                '--bpl-shadow': 'rgba(0,5,2,.52)', '--bpl-shadow-strong': 'rgba(0,4,2,.72)',
                '--bpl-accent-shadow': 'rgba(159,197,168,.22)',
                '--bpl-control-shadow': 'inset 0 1px 0 rgba(246,243,224,.13),0 1px 3px rgba(0,5,2,.42)',
                '--bpl-control-active-shadow': 'inset 0 2px 5px rgba(0,5,2,.54)',
                '--bpl-surface-highlight': 'rgba(246,243,224,.09)',
                '--bpl-page-bg': 'linear-gradient(145deg,#070a08 0%,#0d1710 48%,#193226 100%)',
                '--bpl-surface-bg': 'linear-gradient(145deg,#0d1510 0%,#17291e 64%,#244331 100%)',
                '--bpl-toolbar-bg': 'rgba(10,17,12,.86)', '--bpl-player-border': '#4c6051',
                '--bpl-decor-opacity': '.5',
                '--bpl-decor-image': 'radial-gradient(ellipse at 0 100%,transparent 0 68%,rgba(218,226,211,.11) 69%,transparent 70% 100%),radial-gradient(ellipse at 100% 0,transparent 0 72%,rgba(130,157,137,.1) 73%,transparent 74% 100%)',
                '--bpl-decor-size': '223px 181px,277px 229px',
                '--bpl-decor-position': '11px 17px,71px 43px',
                '--bpl-decor-mask': 'linear-gradient(to bottom,transparent,#000 12%,#000)',
                '--bpl-ambient-filter': 'blur(30px) brightness(.36) saturate(1.18)', '--bpl-ambient-opacity': '.68'
            }
        },
        {
            id: 'gold', name: '曜石金',
            swatch: 'linear-gradient(135deg,#151518 0 50%,#d4af37 50%)',
            vars: {
                '--bpl-page': '#0d0d0f', '--bpl-surface': '#151518', '--bpl-raised': '#1e1e22',
                '--bpl-control': '#2a2926', '--bpl-hover': '#3b3830', '--bpl-border': '#2c2b2b',
                '--bpl-border-strong': '#5e5540', '--bpl-border-hover': '#d4af37',
                '--bpl-text': '#f5f1e8', '--bpl-text-strong': '#fffaf0', '--bpl-muted': '#cfc3a7',
                '--bpl-subtle': '#a99b7b', '--bpl-faint': '#7f735d', '--bpl-accent': '#d4af37',
                '--bpl-accent-hover': '#e7c75b', '--bpl-accent-soft': '#3a321c',
                '--bpl-accent-border': 'rgba(212,175,55,.62)', '--bpl-on-accent': '#1a1400',
                '--bpl-danger': '#ff9d95', '--bpl-danger-strong': '#ff7b72', '--bpl-danger-soft': '#432422',
                '--bpl-track': '#5a4b23', '--bpl-scroll': '#b8952e',
                '--bpl-control-soft': 'rgba(212,175,55,.12)', '--bpl-control-soft-hover': 'rgba(212,175,55,.22)',
                '--bpl-shadow': 'rgba(0,0,0,.5)', '--bpl-shadow-strong': 'rgba(0,0,0,.68)',
                '--bpl-accent-shadow': 'rgba(212,175,55,.32)',
                '--bpl-control-shadow': 'inset 0 1px 0 rgba(255,244,201,.13),0 1px 2px rgba(0,0,0,.36)',
                '--bpl-control-active-shadow': 'inset 0 2px 4px rgba(0,0,0,.42)',
                '--bpl-surface-highlight': 'rgba(255,244,201,.08)',
                '--bpl-ambient-filter': 'blur(30px) brightness(.38) saturate(1.25)', '--bpl-ambient-opacity': '.78'
            }
        },
        {
            id: 'paper', name: '明亮白',
            swatch: 'linear-gradient(135deg,#ffffff 0 50%,#d84c76 50%)',
            vars: {
                '--bpl-page': '#eef1f4', '--bpl-surface': '#f8fafb', '--bpl-raised': '#ffffff',
                '--bpl-control': '#e7ebef', '--bpl-hover': '#d9e0e7', '--bpl-border': '#dfe4e9',
                '--bpl-border-strong': '#c7cfd8', '--bpl-border-hover': '#aab5c0',
                '--bpl-text': '#29313a', '--bpl-text-strong': '#151a20', '--bpl-muted': '#56616c',
                '--bpl-subtle': '#747f8b', '--bpl-faint': '#929ca6', '--bpl-accent': '#d84c76',
                '--bpl-accent-hover': '#c83f69', '--bpl-accent-soft': '#fdebf1',
                '--bpl-accent-border': 'rgba(216,76,118,.5)', '--bpl-on-accent': '#ffffff',
                '--bpl-danger': '#c83d49', '--bpl-danger-strong': '#aa2835', '--bpl-danger-soft': '#fae5e8',
                '--bpl-track': '#cdd5dd', '--bpl-scroll': '#b9c3cd',
                '--bpl-control-soft': 'rgba(20,28,36,.06)', '--bpl-control-soft-hover': 'rgba(20,28,36,.12)',
                '--bpl-shadow': 'rgba(24,31,38,.2)', '--bpl-shadow-strong': 'rgba(24,31,38,.3)',
                '--bpl-accent-shadow': 'rgba(216,76,118,.28)',
                '--bpl-control-shadow': 'inset 0 1px 0 rgba(255,255,255,.82),0 1px 2px rgba(24,31,38,.14)',
                '--bpl-control-active-shadow': 'inset 0 2px 4px rgba(24,31,38,.16)',
                '--bpl-surface-highlight': 'rgba(255,255,255,.85)',
                '--bpl-ambient-filter': 'blur(30px) brightness(1.12) saturate(.72)', '--bpl-ambient-opacity': '.22'
            }
        },
        {
            id: 'starry', name: '星夜蓝',
            swatch: 'linear-gradient(135deg,#020617 0%,#0b3d91 56%,#38bdf8 100%)',
            vars: {
                '--bpl-page': '#03132f', '--bpl-surface': '#072554', '--bpl-raised': '#0b326b',
                '--bpl-control': '#12457f', '--bpl-hover': '#1c5ca0', '--bpl-border': '#0b2d61',
                '--bpl-border-strong': '#2875ae', '--bpl-border-hover': '#7dd3fc',
                '--bpl-text': '#edf8ff', '--bpl-text-strong': '#ffffff', '--bpl-muted': '#c7e8fb',
                '--bpl-subtle': '#9bcbea', '--bpl-faint': '#6da5cc', '--bpl-accent': '#7dd3fc',
                '--bpl-accent-hover': '#bae6fd', '--bpl-accent-soft': 'rgba(14,165,233,.22)',
                '--bpl-accent-border': 'rgba(125,211,252,.72)', '--bpl-on-accent': '#06243d',
                '--bpl-danger': '#fda4af', '--bpl-danger-strong': '#fb7185', '--bpl-danger-soft': 'rgba(159,18,57,.34)',
                '--bpl-track': '#246a9f', '--bpl-scroll': '#38bdf8',
                '--bpl-control-soft': 'rgba(125,211,252,.12)', '--bpl-control-soft-hover': 'rgba(125,211,252,.24)',
                '--bpl-shadow': 'rgba(0,6,24,.46)', '--bpl-shadow-strong': 'rgba(0,4,18,.68)',
                '--bpl-accent-shadow': 'rgba(56,189,248,.38)',
                '--bpl-control-shadow': 'inset 0 1px 0 rgba(255,255,255,.2),0 1px 2px rgba(0,6,24,.38)',
                '--bpl-control-active-shadow': 'inset 0 2px 4px rgba(0,6,24,.46)',
                '--bpl-surface-highlight': 'rgba(255,255,255,.14)',
                '--bpl-page-bg': 'linear-gradient(155deg,#020617 0%,#071b4a 46%,#126da0 100%)',
                '--bpl-surface-bg': 'linear-gradient(145deg,#06132f 0%,#0a2f6d 58%,#0b5c93 100%)',
                '--bpl-decor-opacity': '.76',
                '--bpl-decor-image': [
                    'radial-gradient(circle at 3% 8%,rgba(255,255,255,.94) 0 1px,transparent 1.7px)',
                    'radial-gradient(circle at 11% 23%,rgba(125,211,252,.8) 0 .9px,transparent 1.5px)',
                    'radial-gradient(circle at 18% 5%,rgba(255,255,255,.52) 0 .7px,transparent 1.3px)',
                    'radial-gradient(circle at 26% 36%,rgba(186,230,253,.72) 0 .8px,transparent 1.4px)',
                    'radial-gradient(circle at 34% 14%,rgba(255,255,255,.88) 0 1.1px,transparent 1.8px)',
                    'radial-gradient(circle at 42% 29%,rgba(125,211,252,.58) 0 .7px,transparent 1.3px)',
                    'radial-gradient(circle at 49% 7%,rgba(255,255,255,.68) 0 .8px,transparent 1.4px)',
                    'radial-gradient(circle at 57% 41%,rgba(186,230,253,.86) 0 1px,transparent 1.7px)',
                    'radial-gradient(circle at 65% 18%,rgba(255,255,255,.46) 0 .7px,transparent 1.2px)',
                    'radial-gradient(circle at 73% 32%,rgba(125,211,252,.78) 0 .9px,transparent 1.5px)',
                    'radial-gradient(circle at 81% 10%,rgba(255,255,255,.9) 0 1px,transparent 1.7px)',
                    'radial-gradient(circle at 89% 27%,rgba(186,230,253,.56) 0 .7px,transparent 1.3px)',
                    'radial-gradient(circle at 96% 44%,rgba(255,255,255,.7) 0 .8px,transparent 1.4px)',
                    'radial-gradient(circle at 7% 52%,rgba(125,211,252,.9) 0 1.1px,transparent 1.8px)',
                    'radial-gradient(circle at 15% 68%,rgba(255,255,255,.48) 0 .7px,transparent 1.2px)',
                    'radial-gradient(circle at 23% 47%,rgba(186,230,253,.7) 0 .8px,transparent 1.4px)',
                    'radial-gradient(circle at 31% 79%,rgba(255,255,255,.86) 0 1px,transparent 1.7px)',
                    'radial-gradient(circle at 39% 58%,rgba(125,211,252,.54) 0 .7px,transparent 1.3px)',
                    'radial-gradient(circle at 47% 91%,rgba(255,255,255,.72) 0 .8px,transparent 1.4px)',
                    'radial-gradient(circle at 55% 63%,rgba(186,230,253,.92) 0 1.1px,transparent 1.8px)',
                    'radial-gradient(circle at 63% 83%,rgba(255,255,255,.5) 0 .7px,transparent 1.2px)',
                    'radial-gradient(circle at 71% 54%,rgba(125,211,252,.74) 0 .9px,transparent 1.5px)',
                    'radial-gradient(circle at 79% 74%,rgba(255,255,255,.84) 0 1px,transparent 1.7px)',
                    'radial-gradient(circle at 87% 61%,rgba(186,230,253,.58) 0 .7px,transparent 1.3px)',
                    'radial-gradient(circle at 94% 86%,rgba(255,255,255,.68) 0 .8px,transparent 1.4px)',
                    'radial-gradient(circle at 4% 94%,rgba(125,211,252,.82) 0 1px,transparent 1.7px)',
                    'radial-gradient(circle at 13% 39%,rgba(255,255,255,.5) 0 .7px,transparent 1.2px)',
                    'radial-gradient(circle at 21% 88%,rgba(186,230,253,.76) 0 .9px,transparent 1.5px)',
                    'radial-gradient(circle at 29% 25%,rgba(255,255,255,.92) 0 1.1px,transparent 1.8px)',
                    'radial-gradient(circle at 37% 72%,rgba(125,211,252,.56) 0 .7px,transparent 1.3px)',
                    'radial-gradient(circle at 45% 49%,rgba(255,255,255,.66) 0 .8px,transparent 1.4px)',
                    'radial-gradient(circle at 53% 16%,rgba(186,230,253,.84) 0 1px,transparent 1.7px)',
                    'radial-gradient(circle at 61% 97%,rgba(255,255,255,.44) 0 .7px,transparent 1.2px)',
                    'radial-gradient(circle at 69% 37%,rgba(125,211,252,.7) 0 .8px,transparent 1.4px)',
                    'radial-gradient(circle at 77% 94%,rgba(255,255,255,.9) 0 1px,transparent 1.7px)',
                    'radial-gradient(circle at 85% 46%,rgba(186,230,253,.54) 0 .7px,transparent 1.3px)',
                    'radial-gradient(circle at 93% 69%,rgba(255,255,255,.74) 0 .9px,transparent 1.5px)',
                    'radial-gradient(circle at 9% 82%,rgba(125,211,252,.62) 0 .8px,transparent 1.4px)',
                    'radial-gradient(circle at 33% 96%,rgba(255,255,255,.82) 0 1px,transparent 1.7px)',
                    'radial-gradient(circle at 58% 75%,rgba(186,230,253,.64) 0 .8px,transparent 1.4px)'
                ].join(','),
                '--bpl-decor-size': '100% 100%', '--bpl-decor-position': '0 0', '--bpl-decor-repeat': 'no-repeat',
                '--bpl-decor-filter': 'drop-shadow(0 0 2px rgba(125,211,252,.46))',
                '--bpl-decor-mask': 'linear-gradient(to bottom,transparent,#000 12%,#000)',
                '--bpl-ambient-filter': 'blur(30px) brightness(.5) saturate(1.55)', '--bpl-ambient-opacity': '.74'
            }
        },
        {
            id: 'glass', name: '冰川玻璃',
            swatch: 'linear-gradient(135deg,#203440 0%,#657c86 58%,#b0b9bc 100%)',
            vars: {
                '--bpl-page': '#182c39', '--bpl-surface': 'rgba(29,48,61,.5)', '--bpl-raised': 'rgba(177,189,194,.12)',
                '--bpl-control': 'rgba(185,196,200,.09)', '--bpl-hover': 'rgba(202,211,214,.17)', '--bpl-border': 'rgba(168,177,181,.14)',
                '--bpl-border-strong': 'rgba(178,187,191,.34)', '--bpl-border-hover': 'rgba(207,214,217,.58)',
                '--bpl-text': '#edf4f5', '--bpl-text-strong': '#ffffff', '--bpl-muted': '#ccd9dc',
                '--bpl-subtle': '#a8b9be', '--bpl-faint': '#7f9299', '--bpl-accent': '#a8d2d7',
                '--bpl-accent-hover': '#c5e2e5', '--bpl-accent-soft': 'rgba(151,184,190,.16)',
                '--bpl-accent-border': 'rgba(168,199,204,.56)', '--bpl-on-accent': '#1b3038',
                '--bpl-danger': '#ffacd2', '--bpl-danger-strong': '#ff82ba', '--bpl-danger-soft': 'rgba(134,31,82,.34)',
                '--bpl-track': 'rgba(184,202,208,.3)', '--bpl-scroll': 'rgba(174,195,201,.5)',
                '--bpl-control-soft': 'rgba(190,201,205,.1)', '--bpl-control-soft-hover': 'rgba(208,216,219,.21)',
                '--bpl-shadow': 'rgba(9,23,31,.32)', '--bpl-shadow-strong': 'rgba(7,18,25,.5)',
                '--bpl-accent-shadow': 'rgba(151,190,196,.28)',
                '--bpl-control-shadow': 'inset 0 1px 0 rgba(235,241,243,.27),0 2px 5px rgba(9,23,31,.22)',
                '--bpl-control-active-shadow': 'inset 0 2px 5px rgba(9,23,31,.34)',
                '--bpl-surface-highlight': 'rgba(229,236,238,.28)',
                '--bpl-page-bg': 'transparent',
                '--bpl-surface-bg': 'linear-gradient(135deg,rgba(182,198,205,.15),rgba(72,94,107,.045))',
                '--bpl-panel-bg': 'linear-gradient(145deg,rgba(20,41,56,.1),rgba(104,120,127,.045))',
                '--bpl-list-bg': 'transparent', '--bpl-toolbar-bg': 'rgba(47,65,75,.09)',
                '--bpl-player-border': 'rgba(191,201,205,.4)', '--bpl-swatch-border': '#859196',
                '--bpl-mini-bg': 'rgba(67,82,90,.22)',
                '--bpl-text-shadow': '0 1px 2px rgba(0,8,16,.88),0 0 5px rgba(0,20,34,.56)',
                '--bpl-mini-icon-filter': 'drop-shadow(0 1px 1px rgba(0,9,16,.92)) drop-shadow(0 0 2px rgba(0,9,16,.68))',
                '--bpl-mini-icon-outline': 'rgba(0,12,20,.72)', '--bpl-mini-icon-stroke': '1.1',
                '--bpl-player-backdrop': 'blur(7px) saturate(1.12)',
                '--bpl-toolbar-backdrop': 'blur(5px) saturate(1.08)',
                '--bpl-panel-backdrop': 'blur(5px) saturate(1.08)',
                '--bpl-ambient-filter': 'blur(24px) brightness(.78) saturate(1.18)', '--bpl-ambient-opacity': '.28'
            }
        },
        {
            id: 'clear', name: '纯净玻璃',
            swatch: 'linear-gradient(135deg,rgba(7,18,28,.22),rgba(210,250,255,.72))',
            vars: {
                '--bpl-page': '#091821', '--bpl-surface': 'rgba(6,18,27,.03)', '--bpl-raised': 'rgba(235,252,255,.04)',
                '--bpl-control': 'rgba(235,252,255,.025)', '--bpl-hover': 'rgba(220,250,255,.08)', '--bpl-border': 'rgba(220,250,255,.09)',
                '--bpl-border-strong': 'rgba(220,250,255,.2)', '--bpl-border-hover': 'rgba(220,250,255,.38)',
                '--bpl-text': '#eefcff', '--bpl-text-strong': '#ffffff', '--bpl-muted': '#d0edf1',
                '--bpl-subtle': '#a8cbd0', '--bpl-faint': '#80a8af', '--bpl-accent': '#b9f7ff',
                '--bpl-accent-hover': '#ffffff', '--bpl-accent-soft': 'rgba(185,247,255,.075)',
                '--bpl-accent-border': 'rgba(185,247,255,.34)', '--bpl-on-accent': '#092b35',
                '--bpl-danger': '#ffc0dc', '--bpl-danger-strong': '#ff9dcc', '--bpl-danger-soft': 'rgba(150,35,91,.18)',
                '--bpl-track': 'rgba(220,250,255,.18)', '--bpl-scroll': 'rgba(220,250,255,.28)',
                '--bpl-control-soft': 'rgba(235,252,255,.035)', '--bpl-control-soft-hover': 'rgba(235,252,255,.11)',
                '--bpl-shadow': 'rgba(0,12,20,.18)', '--bpl-shadow-strong': 'rgba(0,10,18,.3)',
                '--bpl-accent-shadow': 'rgba(185,247,255,.18)',
                '--bpl-control-shadow': 'inset 0 1px 0 rgba(255,255,255,.16),0 2px 5px rgba(0,12,20,.12)',
                '--bpl-control-active-shadow': 'inset 0 2px 5px rgba(0,12,20,.22)',
                '--bpl-surface-highlight': 'rgba(255,255,255,.18)',
                '--bpl-page-bg': 'transparent',
                '--bpl-surface-bg': 'linear-gradient(135deg,rgba(255,255,255,.035),rgba(255,255,255,.008))',
                '--bpl-panel-bg': 'transparent', '--bpl-list-bg': 'transparent',
                '--bpl-toolbar-bg': 'rgba(235,252,255,.015)',
                '--bpl-player-border': 'rgba(220,250,255,.22)', '--bpl-swatch-border': '#91a7ac',
                '--bpl-text-shadow': '0 1px 2px rgba(0,8,16,.82),0 0 8px rgba(0,20,34,.46)',
                '--bpl-mini-icon-filter': 'drop-shadow(0 1px 1px rgba(0,7,13,.98)) drop-shadow(0 0 2px rgba(0,7,13,.82))',
                '--bpl-mini-icon-outline': 'rgba(0,9,16,.88)', '--bpl-mini-icon-stroke': '1.25',
                '--bpl-player-backdrop': 'none',
                '--bpl-toolbar-backdrop': 'none',
                '--bpl-panel-backdrop': 'none',
                '--bpl-ambient-filter': 'none', '--bpl-ambient-opacity': '0'
            }
        }
    ];

    const variableNames = [];
    themes.forEach(theme => Object.keys(theme.vars).forEach(key => {
        if (variableNames.indexOf(key) < 0) variableNames.push(key);
    }));

    function get(id) {
        const resolvedId = id === 'forest' || id === 'rain' || id === 'firefly' ? 'jade' : id;
        return themes.find(theme => theme.id === resolvedId) || themes.find(theme => theme.id === DEFAULT_ID) || themes[0];
    }

    function apply(target, id) {
        const theme = get(id);
        if (!target || !target.style) return theme;
        if (target.setAttribute) target.setAttribute('data-bpl-theme', theme.id);
        if (target.style.removeProperty) variableNames.forEach(key => target.style.removeProperty(key));
        Object.keys(theme.vars).forEach(key => target.style.setProperty(key, theme.vars[key]));
        return theme;
    }

    root.BPLTheme = { STORAGE_KEY: STORAGE_KEY, DEFAULT_ID: DEFAULT_ID, themes: themes, get: get, apply: apply };
})(globalThis);
