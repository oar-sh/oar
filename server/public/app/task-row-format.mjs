// Formatting shared by the background-task panel rows and the sub-agent rows
// (reply bubble, viewer). Pure: no DOM, no store.

import { humanizeModelLabel } from './model-selector-options.mjs';

// "claude-opus-5-5" → "Opus 5.5". A bare alias ("opus") is what a spawn pin
// carries until the subagent's first answer names the real model.
export function formatTaskModelLabel(model) {
  const value = String(model || '').trim();
  if (!value) return '';
  if (/^claude-/i.test(value)) return humanizeModelLabel(value);
  if (/^[a-z]+(\[[^\]]+\])?$/i.test(value)) return value.charAt(0).toUpperCase() + value.slice(1);
  return humanizeModelLabel(value);
}

// Compact token counts: "812 tok", "62.2k tok", "1.2M tok". Exported for the
// transcript's finished-workflow card, which shares the panel's formatting.
export function formatTaskTokens(totalTokens) {
  const tokens = Number(totalTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  if (tokens < 1000) return `${tokens} tok`;
  if (tokens < 1_000_000) {
    const thousands = tokens / 1000;
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k tok`;
  }
  const millions = tokens / 1_000_000;
  return `${millions >= 100 ? Math.round(millions) : millions.toFixed(1)}M tok`;
}

