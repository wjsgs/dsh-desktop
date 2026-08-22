'use strict';

/** Bridge for the update window page. */
const { ipcRenderer } = require('electron');

window.updateApi = {
  onState: (cb) => ipcRenderer.on('update-state', (_e, state) => cb(state)),
  action: (a) => ipcRenderer.send('update-action', a),
};
