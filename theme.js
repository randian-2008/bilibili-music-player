(function (root) {
    'use strict';

    const STORAGE_KEY = 'bpl_theme';
    const DEFAULT_ID = 'classic';
    const themes = [
        {
            id: 'classic', name: '经典粉',
            swatch: 'linear-gradient(135deg,#202024 0 62%,#fb7299 62%)',
            vars: {
                '--bpl-page': '#141517', '--bpl-surface': '#1b1c20', '--bpl-raised': '#202024',
                '--bpl-control': '#2b2b2f', '--bpl-hover': '#3a3a3f', '--bpl-border': '#2a2b30',
                '--bpl-border-strong': '#3a3a3f', '--bpl-border-hover': '#55555c',
                '--bpl-text': '#e8e8e8', '--bpl-text-strong': '#f3f3f5', '--bpl-muted': '#a9abb2',
                '--bpl-subtle': '#8a8a92', '--bpl-faint': '#747680', '--bpl-accent': '#fb7299',
                '--bpl-accent-hover': '#fc8bab', '--bpl-accent-soft': '#2a2026',
                '--bpl-accent-border': 'rgba(251,114,153,.55)', '--bpl-on-accent': '#ffffff',
                '--bpl-danger': '#ff8080', '--bpl-danger-strong': '#ff6b6b', '--bpl-danger-soft': '#3a2626',
                '--bpl-track': '#34353b', '--bpl-scroll': '#3a3a3f',
                '--bpl-control-soft': 'rgba(255,255,255,.07)', '--bpl-control-soft-hover': 'rgba(255,255,255,.16)',
                '--bpl-shadow': 'rgba(0,0,0,.45)', '--bpl-shadow-strong': 'rgba(0,0,0,.6)',
                '--bpl-accent-shadow': 'rgba(251,114,153,.4)',
                '--bpl-control-shadow': 'inset 0 1px 0 rgba(255,255,255,.12),0 1px 2px rgba(0,0,0,.24)',
                '--bpl-control-active-shadow': 'inset 0 2px 4px rgba(0,0,0,.24)',
                '--bpl-surface-highlight': 'rgba(255,255,255,.07)',
                '--bpl-ambient-filter': 'blur(30px) brightness(.42) saturate(1.5)', '--bpl-ambient-opacity': '.85'
            }
        },
        {
            id: 'ocean', name: '钴蓝黄',
            swatch: 'linear-gradient(135deg,#075c99 0 58%,#ffd43b 58%)',
            vars: {
                '--bpl-page': '#064f85', '--bpl-surface': '#075c99', '--bpl-raised': '#0b6aae',
                '--bpl-control': '#1479bb', '--bpl-hover': '#278bcb', '--bpl-border': '#0a619f',
                '--bpl-border-strong': '#43a3db', '--bpl-border-hover': '#ffd43b',
                '--bpl-text': '#f3f9ff', '--bpl-text-strong': '#ffffff', '--bpl-muted': '#d4ecff',
                '--bpl-subtle': '#a8d5f5', '--bpl-faint': '#7eb9e1', '--bpl-accent': '#ffd43b',
                '--bpl-accent-hover': '#ffe273', '--bpl-accent-soft': '#225f88',
                '--bpl-accent-border': 'rgba(255,212,59,.72)', '--bpl-on-accent': '#292300',
                '--bpl-danger': '#ffc1c7', '--bpl-danger-strong': '#ff9aa5', '--bpl-danger-soft': '#794556',
                '--bpl-track': '#58a9dc', '--bpl-scroll': '#ffd43b',
                '--bpl-control-soft': 'rgba(255,212,59,.16)', '--bpl-control-soft-hover': 'rgba(255,212,59,.28)',
                '--bpl-shadow': 'rgba(0,28,55,.34)', '--bpl-shadow-strong': 'rgba(0,24,48,.48)',
                '--bpl-accent-shadow': 'rgba(255,212,59,.34)',
                '--bpl-control-shadow': 'inset 0 1px 0 rgba(255,255,255,.2),0 1px 2px rgba(0,28,55,.34)',
                '--bpl-control-active-shadow': 'inset 0 2px 4px rgba(0,28,55,.38)',
                '--bpl-surface-highlight': 'rgba(255,255,255,.14)',
                '--bpl-ambient-filter': 'blur(30px) brightness(.62) saturate(1.45)', '--bpl-ambient-opacity': '.72'
            }
        },
        {
            id: 'forest', name: '翡翠珊瑚',
            swatch: 'linear-gradient(135deg,#126b50 0 58%,#ff8a65 58%)',
            vars: {
                '--bpl-page': '#0f5c45', '--bpl-surface': '#126b50', '--bpl-raised': '#19785c',
                '--bpl-control': '#23866a', '--bpl-hover': '#34987b', '--bpl-border': '#176a53',
                '--bpl-border-strong': '#5ab494', '--bpl-border-hover': '#ff9b72',
                '--bpl-text': '#f2fff9', '--bpl-text-strong': '#ffffff', '--bpl-muted': '#d3f3e5',
                '--bpl-subtle': '#a7dcc9', '--bpl-faint': '#7bc4ac', '--bpl-accent': '#ff8a65',
                '--bpl-accent-hover': '#ffa17f', '--bpl-accent-soft': '#286b59',
                '--bpl-accent-border': 'rgba(255,138,101,.7)', '--bpl-on-accent': '#351208',
                '--bpl-danger': '#ffd0d5', '--bpl-danger-strong': '#ffadb7', '--bpl-danger-soft': '#794653',
                '--bpl-track': '#62b69a', '--bpl-scroll': '#ff8a65',
                '--bpl-control-soft': 'rgba(255,138,101,.16)', '--bpl-control-soft-hover': 'rgba(255,138,101,.27)',
                '--bpl-shadow': 'rgba(0,38,27,.34)', '--bpl-shadow-strong': 'rgba(0,31,23,.48)',
                '--bpl-accent-shadow': 'rgba(255,138,101,.32)',
                '--bpl-control-shadow': 'inset 0 1px 0 rgba(255,255,255,.18),0 1px 2px rgba(0,38,27,.34)',
                '--bpl-control-active-shadow': 'inset 0 2px 4px rgba(0,38,27,.38)',
                '--bpl-surface-highlight': 'rgba(255,255,255,.13)',
                '--bpl-ambient-filter': 'blur(30px) brightness(.6) saturate(1.4)', '--bpl-ambient-opacity': '.7'
            }
        },
        {
            id: 'gold', name: '曜石金',
            swatch: 'linear-gradient(135deg,#151518 0 58%,#d4af37 58%)',
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
            swatch: 'linear-gradient(135deg,#ffffff 0 62%,#d84c76 62%)',
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
                '--bpl-stars-opacity': '.72',
                '--bpl-ambient-filter': 'blur(30px) brightness(.5) saturate(1.55)', '--bpl-ambient-opacity': '.74'
            }
        }
    ];

    const variableNames = [];
    themes.forEach(theme => Object.keys(theme.vars).forEach(key => {
        if (variableNames.indexOf(key) < 0) variableNames.push(key);
    }));

    function get(id) {
        return themes.find(theme => theme.id === id) || themes[0];
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
