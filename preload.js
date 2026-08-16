'use strict';

/**
 * Renderer-side observer for the dsh web UI.
 *
 * Watches two DOM signals and reports transitions to the main process:
 *  - pending questions / plan reviews: any [data-question-key] or
 *    [data-plan-review-key] overlay is mounted
 *  - task running/done: the composer input is disabled while the agent is
 *    busy, and new conversation anchors appear as messages finish
 */

const { ipcRenderer } = require('electron');

const QUESTION_SEL = '[data-question-key], [data-plan-review-key]';
const COMPOSER_SEL = [
  '[data-composer-seat] textarea',
  '[data-composer-seat] input',
  '[data-composer-seat] [contenteditable="true"]',
].join(', ');
const MESSAGE_SEL = '[data-chat-anchor-key]';

function readState() {
  const composer = document.querySelector(COMPOSER_SEL);
  return {
    hasQuestion: document.querySelector(QUESTION_SEL) !== null,
    composerBusy: composer !== null && composer.disabled === true,
    messageCount: document.querySelectorAll(MESSAGE_SEL).length,
  };
}

let last = readState();
// Message count snapshot taken when busy started; a task "finished" only if
// new content landed while it was busy.
let busyStartMessages = null;

function tick() {
  const s = readState();
  const events = [];

  if (s.hasQuestion && !last.hasQuestion) events.push('question');
  if (!s.hasQuestion && last.hasQuestion) events.push('question-cleared');

  if (s.composerBusy && !last.composerBusy) {
    busyStartMessages = last.messageCount;
  }
  if (!s.composerBusy && last.composerBusy) {
    const grew = busyStartMessages !== null && s.messageCount > busyStartMessages;
    busyStartMessages = null;
    if (grew) events.push('task-done');
  }

  last = s;
  for (const e of events) ipcRenderer.send('dsh-attention', e);
}

// The conversation is a React tree; a light poll is cheaper and far more
// robust against re-mounts than a MutationObserver over the whole body.
setInterval(tick, 1000);

// Marker so the main process / debugging can confirm the preload attached.
window.__dshDesktopPreload = true;
