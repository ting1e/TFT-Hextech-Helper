import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Vitest 配置
 * @description 仅用于后端状态机的纯逻辑 / Mock 测试，不加载 Electron 和原生模块。
 *              - electron 在 test/vitest.setup.ts 中通过 vi.mock 替换
 *              - 无法在纯 Node 环境加载的原生模块通过 alias 指向 stub
 */
const aliases = {
    'electron': resolve(__dirname, 'test/stubs/electron.ts'),
    '@nut-tree-fork/nut-js': resolve(__dirname, 'test/stubs/nut-js.ts'),
    'sharp': resolve(__dirname, 'test/stubs/sharp.ts'),
    '@techstark/opencv-js': resolve(__dirname, 'test/stubs/opencv.ts'),
    'tesseract.js': resolve(__dirname, 'test/stubs/tesseract.ts'),
    'uiohook-napi': resolve(__dirname, 'test/stubs/uiohook.ts'),
};

export default defineConfig({
    resolve: {
        alias: aliases,
    },
    test: {
        environment: 'node',
        include: ['src-backend/**/*.test.ts'],
        restoreMocks: true,
        clearMocks: true,
        testTimeout: 30000,
        hookTimeout: 30000,
        alias: aliases,
        server: {
            deps: {
                inline: ['electron'],
            },
        },
    },
});
