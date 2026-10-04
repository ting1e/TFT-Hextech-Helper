/** tesseract.js 测试桩 */
export const createWorker = async () => ({
    recognize: async () => ({ data: { text: '' } }),
    terminate: async () => undefined,
    setParameters: async () => undefined,
});

export default { createWorker };
