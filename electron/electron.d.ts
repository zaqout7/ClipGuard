declare module 'electron' {
  export interface App {
    setName(name: string): void;
    setPath(name: string, value: string): void;
    getPath(name: string): string;
    getAppPath(): string;
    isPackaged: boolean;
    quit(): void;
    whenReady(): Promise<void>;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  export interface WebContents {
    setWindowOpenHandler(handler: (details: any) => { action: string }): void;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  export interface BrowserWindowOptions {
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    autoHideMenuBar?: boolean;
    webPreferences?: {
      preload?: string;
      contextIsolation?: boolean;
      nodeIntegration?: boolean;
      sandbox?: boolean;
      webSecurity?: boolean;
      webviewTag?: boolean;
      allowRunningInsecureContent?: boolean;
    };
  }

  export class BrowserWindow {
    constructor(options?: BrowserWindowOptions);
    webContents: WebContents;
    loadURL(url: string): Promise<void>;
    static getAllWindows(): BrowserWindow[];
  }

  export interface Dialog {
    showErrorBox(title: string, content: string): void;
  }

  export interface ContextBridge {
    exposeInMainWorld(apiKey: string, api: any): void;
  }

  export const app: App;
  export const dialog: Dialog;
  export const contextBridge: ContextBridge;
}
