import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('clipguardDesktop', Object.freeze({
  isDesktop: true,
}));
