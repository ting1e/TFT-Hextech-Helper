/**
 * Electron 测试桩
 * @description 纯 Node 环境无法加载真实 electron，这里通过 vitest alias 提供最小实现。
 */

import { vi } from 'vitest';
import os from 'os';
import path from 'path';

const userData = path.join(os.tmpdir(), 'tft-hextech-helper-test');

export class BrowserWindow {
    public webContents = {
        send: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
    };
    public static getAllWindows(): any[] {
        return [];
    }
    public static fromWebContents(): any {
        return null;
    }
    public static getFocusedWindow(): any {
        return null;
    }
    public isDestroyed = () => false;
    public close = vi.fn();
    public show = vi.fn();
    public loadURL = vi.fn();
    public loadFile = vi.fn();
    public getBounds = () => ({ x: 0, y: 0, width: 1024, height: 768 });
    public isMaximized = () => false;
    public isFullScreen = () => false;
    public once = vi.fn();
    public on = vi.fn();
}

export const app = {
    getPath: () => userData,
    getName: () => 'TFT-Hextech-Helper-Test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    disableHardwareAcceleration: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    on: vi.fn(),
    whenReady: () => Promise.resolve(),
    quit: vi.fn(),
    exit: vi.fn(),
};

export const screen = {
    getPrimaryDisplay: () => ({
        scaleFactor: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
    getDisplayNearestPoint: () => ({
        scaleFactor: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
    getDisplayMatching: () => ({
        scaleFactor: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
};

export const ipcMain = {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
};

export const ipcRenderer = {
    send: vi.fn(),
    invoke: vi.fn(async () => undefined),
    on: vi.fn(),
    removeListener: vi.fn(),
};

export const shell = {
    openExternal: vi.fn(async () => undefined),
};

export const net = {
    fetch: vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
    })),
};

export const dialog = {
    showMessageBox: vi.fn(async () => ({ response: 0 })),
    showErrorBox: vi.fn(),
};

export default {
    app,
    BrowserWindow,
    screen,
    ipcMain,
    ipcRenderer,
    shell,
    net,
    dialog,
};
