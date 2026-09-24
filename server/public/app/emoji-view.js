import { autoResize, isMobileComposerViewport } from './store.js';

const LAST_EMOJI_STORAGE_KEY = 'copilot_last_emoji';
const DEFAULT_EMOJI = '🙂';
const EMOJI_CHOICES = ['🙂', '😀', '😁', '😂', '😊', '😍', '😘', '😎', '🤔', '🙌', '👍', '👏', '🎉', '❤️', '🔥', '✅', '👀', '🤝', '🙏', '💡', '🚀', '✨', '🧠', '🛠️'];

let pickerOpen = false;

function getLastEmoji() {
  const saved = String(localStorage.getItem(LAST_EMOJI_STORAGE_KEY) || '').trim();
  return saved || DEFAULT_EMOJI;
}

function setLastEmoji(emoji) {
  const value = String(emoji || '').trim();
  if (!value) return;
  localStorage.setItem(LAST_EMOJI_STORAGE_KEY, value);
}

function updateEmojiButton() {
  const button = document.getElementById('emoji-btn');
  if (!button) return;
  button.textContent = getLastEmoji();
}

function closeEmojiPicker() {
  const popup = document.getElementById('emoji-popup');
  if (!popup) return;
  popup.classList.remove('visible');
  popup.setAttribute('aria-hidden', 'true');
  pickerOpen = false;
}

function insertEmojiAtCaret(emoji) {
  const input = document.getElementById('msg-input');
  if (!input) return;
  const value = String(input.value || '');
  const start = Number.isFinite(input.selectionStart) ? input.selectionStart : value.length;
  const end = Number.isFinite(input.selectionEnd) ? input.selectionEnd : value.length;
  input.value = `${value.slice(0, start)}${emoji}${value.slice(end)}`;
  const nextCaret = start + emoji.length;
  input.selectionStart = nextCaret;
  input.selectionEnd = nextCaret;
  autoResize(input);
  input.focus();
  // Runs the composer's input pipeline, which saves the draft.
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function handleEmojiChoice(emoji) {
  const value = String(emoji || '').trim();
  if (!value) return;
  setLastEmoji(value);
  updateEmojiButton();
  insertEmojiAtCaret(value);
  closeEmojiPicker();
}

function ensureEmojiChoices() {
  const popup = document.getElementById('emoji-popup');
  if (!popup || popup.dataset.bound === '1') return;
  popup.dataset.bound = '1';
  popup.innerHTML = EMOJI_CHOICES
    .map((emoji) => `<button class="emoji-choice" type="button" data-emoji="${emoji}" aria-label="Insert ${emoji}">${emoji}</button>`)
    .join('');
  popup.addEventListener('click', (event) => {
    const target = event.target?.closest?.('.emoji-choice');
    if (!target) return;
    handleEmojiChoice(target.getAttribute('data-emoji'));
  });
}

export function toggleEmojiPicker() {
  if (isMobileComposerViewport()) return;
  const popup = document.getElementById('emoji-popup');
  if (!popup) return;
  if (pickerOpen) {
    closeEmojiPicker();
    return;
  }
  popup.classList.add('visible');
  popup.setAttribute('aria-hidden', 'false');
  pickerOpen = true;
}

export function initEmojiPicker() {
  ensureEmojiChoices();
  updateEmojiButton();
  if (document.body.dataset.emojiPickerBound === '1') return;
  document.body.dataset.emojiPickerBound = '1';
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeEmojiPicker();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!pickerOpen) return;
    const popup = document.getElementById('emoji-popup');
    const button = document.getElementById('emoji-btn');
    const target = event.target;
    if (popup?.contains(target) || button?.contains(target)) return;
    closeEmojiPicker();
  });
}

