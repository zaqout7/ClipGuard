"use strict";

// electron/preload.ts
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("clipguardDesktop", Object.freeze({
  isDesktop: true
}));
