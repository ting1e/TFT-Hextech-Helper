/** sharp 测试桩：只提供链式调用的最小实现 */
const sharp: any = () => ({
    metadata: async () => ({ width: 0, height: 0 }),
    extract: () => sharp(),
    resize: () => sharp(),
    greyscale: () => sharp(),
    raw: () => sharp(),
    toBuffer: async () => Buffer.alloc(0),
    toFile: async () => undefined,
});

sharp.cache = () => undefined;

export default sharp;
