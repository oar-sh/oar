// Copy buttons for rendered code blocks. Selecting a long <pre> by hand on a
// phone is miserable, so every fenced block gets a small overlay button that
// copies the block's text in one tap.
//
// Buttons are injected by the same enhancement passes that run hljs (the
// rendered nodes are already being touched there), while the click handling
// is one document-level delegated listener — transcript bubbles are re-rendered
// and streamed-patched constantly, so per-button listeners would die with the
// first re-render.

const BUTTON_CLASS = 'code-copy-btn';
const RESET_MS = 1500;

async function copyText(text) {
  // Clipboard API first (requires a secure context — localhost and the
  // cloudflared tunnel both qualify), execCommand as the plain-http fallback.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const holder = document.createElement('textarea');
    holder.value = text;
    holder.setAttribute('readonly', '');
    holder.style.position = 'fixed';
    holder.style.opacity = '0';
    document.body.appendChild(holder);
    holder.select();
    const copied = document.execCommand('copy');
    holder.remove();
    return copied;
  } catch {
    return false;
  }
}

let delegatedBound = false;

function bindDelegatedClick() {
  if (delegatedBound || typeof document === 'undefined') return;
  delegatedBound = true;
  document.addEventListener('click', async (event) => {
    const btn = event.target?.closest?.(`.${BUTTON_CLASS}`);
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    // The button lives inside the <pre> but the copied text comes from the
    // <code> element, so the button's own label never rides along.
    const code = btn.parentElement?.querySelector('code');
    const copied = await copyText(code ? code.textContent : '');
    btn.textContent = copied ? '✓ Copied' : 'Copy failed';
    btn.classList.toggle('is-copied', copied);
    clearTimeout(btn.__copyResetTimer);
    btn.__copyResetTimer = setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('is-copied');
    }, RESET_MS);
  });
}

/**
 * Add a copy button to every `<pre><code>` block under `root` that doesn't
 * have one yet. Idempotent, so the streaming re-enhancement passes can call
 * it repeatedly on the same nodes.
 */
export function attachCodeCopyButtons(root) {
  if (!(root instanceof Element)) return;
  bindDelegatedClick();
  const scopes = root.matches?.('pre') ? [root] : root.querySelectorAll('pre');
  for (const pre of scopes) {
    if (!pre.querySelector('code')) continue;
    if (pre.querySelector(`:scope > .${BUTTON_CLASS}`)) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BUTTON_CLASS;
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy code block');
    // The class (not :has()) anchors the absolutely-positioned button, so the
    // rule works on every browser that renders the transcript.
    pre.classList.add('has-code-copy');
    pre.appendChild(btn);
  }
}
